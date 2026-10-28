import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { probeDuration } from "../util/media.js";
import { commandProvider } from "./command.js";
import { edgeProvider } from "./edge.js";
import { localProvider } from "./local.js";

export interface VoiceInfo {
  name: string;
  locale: string;
  gender: string;
  /** Languages the voice speaks when that is more than its locale (e.g. ["ar", "en"]). */
  langs?: string[];
}

export interface VoiceProvider {
  id: string;
  /** Extension of the clips a voice produces. Default "mp3". */
  ext?(voice: string): string;
  /** Extra text for the clip cache key: settings that change the audio but not the voice name. */
  cacheKey?(voice: string): string;
  synthesize(text: string, voice: string, rate: string, outFile: string): Promise<void>;
  listVoices(): Promise<VoiceInfo[]>;
  /** Stop what synthesis started (a model process). Called when a batch of lines is done. */
  close?(): Promise<void>;
}

const providers: Record<string, VoiceProvider> = { edge: edgeProvider, local: localProvider, command: commandProvider };

export function getProvider(id: string): VoiceProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown voice provider "${id}". Available: ${Object.keys(providers).join(", ")}`);
  return p;
}

/** True when a voice speaks the language (a prefix such as "ar", "ar-EG" or "en-US"). */
export function voiceMatchesLang(v: VoiceInfo, prefix?: string): boolean {
  if (!prefix) return true;
  const p = prefix.toLowerCase();
  return [v.locale, ...(v.langs ?? [])].some((l) => l.toLowerCase().startsWith(p));
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

/** Synthesize lines into `dir`, reusing files whose text/voice/rate did not change. */
export async function synthesizeLines(providerId: string, lines: VoiceLine[], dir: string): Promise<VoiceClip[]> {
  const provider = getProvider(providerId);
  await mkdir(dir, { recursive: true });
  const clips: VoiceClip[] = [];
  try {
    for (const line of lines) {
      const key = `${provider.id}|${line.voice}|${provider.cacheKey?.(line.voice) ?? ""}|${line.rate}|${line.text}`;
      const hash = createHash("sha1").update(key).digest("hex");
      const file = join(dir, `${hash.slice(0, 16)}.${provider.ext?.(line.voice) ?? "mp3"}`);
      if (!existsSync(file)) await provider.synthesize(line.text, line.voice, line.rate, file);
      clips.push({ ...line, file, duration: await probeDuration(file) });
    }
  } finally {
    await provider.close?.();
  }
  return clips;
}
