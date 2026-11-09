import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { run } from "../util/exec.js";
import { type FitEntry, fitLines } from "../storyboard/lint.js";
import { probeDuration } from "../util/media.js";
import { mapLimit } from "../util/pool.js";
import { commandProvider } from "./command.js";
import { edgeProvider } from "./edge.js";
import { elevenLabsProvider } from "./elevenlabs.js";
import { geminiProvider } from "./gemini.js";
import { localProvider } from "./local.js";

export interface VoiceInfo {
  name: string;
  locale: string;
  gender: string;
  /** Languages the voice speaks when that is more than its locale (e.g. ["ar", "en"]); "*" = any language. */
  langs?: string[];
}

export interface VoiceProvider {
  id: string;
  /** Extension of the clips a voice produces. Default "mp3". */
  ext?(voice: string): string;
  /** Extra text for the clip cache key: settings that change the audio but not the voice name. */
  cacheKey?(voice: string): string;
  /** How many lines may be synthesized at once. Default 1; only raise it for a service that allows it. */
  concurrency?: number;
  synthesize(text: string, voice: string, rate: string, outFile: string): Promise<void>;
  listVoices(): Promise<VoiceInfo[]>;
  /** Stop what synthesis started (a model process). Called when a batch of lines is done. */
  close?(): Promise<void>;
}

const providers: Record<string, VoiceProvider> = {
  edge: edgeProvider,
  local: localProvider,
  command: commandProvider,
  elevenlabs: elevenLabsProvider,
  gemini: geminiProvider,
};

export function getProvider(id: string): VoiceProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown voice provider "${id}". Available: ${Object.keys(providers).join(", ")}`);
  return p;
}

/** True when a voice speaks the language (a prefix such as "ar", "ar-EG" or "en-US"). */
export function voiceMatchesLang(v: VoiceInfo, prefix?: string): boolean {
  if (!prefix) return true;
  const p = prefix.toLowerCase();
  return [v.locale, ...(v.langs ?? [])].some((l) => l === "*" || l.toLowerCase().startsWith(p));
}

export interface VoiceLine {
  text: string;
  voice: string;
  rate: string;
}

export interface VoiceClip extends VoiceLine {
  file: string;
  duration: number;
}

/**
 * Duration of a clip. The first probe is saved next to the clip (`<file>.dur`),
 * so cached clips are not run through ffprobe on every build.
 */
export async function clipDuration(file: string): Promise<number> {
  const sidecar = `${file}.dur`;
  try {
    const cached = Number.parseFloat(await readFile(sidecar, "utf8"));
    if (Number.isFinite(cached) && cached > 0) return cached;
  } catch {
    // no sidecar yet
  }
  const duration = await probeDuration(file);
  await writeFile(sidecar, String(duration)).catch(() => {});
  return duration;
}

/** The cache file of a line: named from the provider, voice, settings, rate and text, so a changed line gets a new clip. */
export function clipFile(provider: VoiceProvider, line: VoiceLine, dir: string): string {
  const key = `${provider.id}|${line.voice}|${provider.cacheKey?.(line.voice) ?? ""}|${line.rate}|${line.text}`;
  const hash = createHash("sha1").update(key).digest("hex");
  return join(dir, `${hash.slice(0, 16)}.${provider.ext?.(line.voice) ?? "mp3"}`);
}

/** Synthesize lines into `dir`, reusing files whose text/voice/rate did not change. */
export async function synthesizeLines(providerId: string, lines: VoiceLine[], dir: string): Promise<VoiceClip[]> {
  const provider = getProvider(providerId);
  await mkdir(dir, { recursive: true });
  try {
    return await mapLimit(lines, provider.concurrency ?? 1, async (line) => {
      const file = clipFile(provider, line, dir);
      if (!existsSync(file)) await provider.synthesize(line.text, line.voice, line.rate, file);
      return { ...line, file, duration: await clipDuration(file) };
    });
  } finally {
    await provider.close?.();
  }
}

/** Rough spoken length of a line (Arabic or English), for dry runs that must not synthesize. */
export function estimateLineSeconds(text: string): number {
  return Math.max(1.2, text.replace(/\s/g, "").length / 13);
}

/**
 * Length of every line in seconds. A dry run estimates them: synthesizing would
 * write clips under the same cache key that the real take then reuses.
 */
export async function lineDurations(providerId: string, lines: VoiceLine[], dir: string, dryRun = false): Promise<number[]> {
  if (dryRun) return lines.map((l) => estimateLineSeconds(l.text));
  return (await synthesizeLines(providerId, lines, dir)).map((c) => c.duration);
}

/**
 * A clip sped up by `factor` (ffmpeg atempo, pitch kept), next to the raw one in the voice cache as
 * `<raw name>.x<factor>.<ext>`. It is always made from the raw clip and reused when it exists, so a
 * re-render never stretches a clip twice.
 */
export async function fitClip(clip: VoiceClip, factor: number): Promise<VoiceClip> {
  const ext = extname(clip.file);
  const stem = clip.file.slice(0, clip.file.length - ext.length);
  const file = `${stem}.x${factor.toFixed(3)}${ext}`;
  if (!existsSync(file)) {
    // Written under a temporary name (ffmpeg picks the format from the extension), so a failed run leaves no half clip.
    const partial = `${stem}.x${factor.toFixed(3)}.partial${ext}`;
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", clip.file, "-vn", "-filter:a", `atempo=${factor}`, partial]);
    await rename(partial, file);
  }
  return { ...clip, file, duration: await clipDuration(file) };
}

/**
 * The fit of the lines whose clip is already in the voice cache (or ready-made audio): nothing is synthesized, so
 * it costs nothing. `unmeasured` counts the lines that have no clip yet.
 */
export async function cachedFit(
  sb: { narration: { id?: string; at: number; text: string; voice?: string; audio?: string }[]; voice: { provider: string; name: string; rate: string; gap: number } },
  baseDir: string,
  cacheDir: string,
): Promise<{ entries: FitEntry[]; unmeasured: number }> {
  const provider = getProvider(sb.voice.provider);
  const lines: { id: string; index: number; at: number; duration: number }[] = [];
  let unmeasured = 0;
  const known = new Map<number, number>();
  for (const [i, l] of sb.narration.entries()) {
    const file = l.audio ? resolve(baseDir, l.audio) : clipFile(provider, { text: l.text, voice: l.voice ?? sb.voice.name, rate: sb.voice.rate }, cacheDir);
    if (!existsSync(file)) {
      unmeasured++;
      continue;
    }
    known.set(i, l.audio ? await probeDuration(file) : await clipDuration(file));
  }
  for (const [i, l] of sb.narration.entries()) lines.push({ id: l.id ?? String(i), index: i, at: l.at, duration: known.get(i) ?? 0 });
  const entries = fitLines(lines, sb.voice.gap).filter((e) => known.has(e.index));
  return { entries, unmeasured };
}
