import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { CACHE_DIR } from "../brand.js";
import { recordEvent } from "../history/index.js";
import { startJob } from "../history/jobs.js";
import { renderStoryboard } from "../render/index.js";
import { checkTranslations, type SubtitleLanguage, writeTimelineSubtitles } from "../render/subtitle-langs.js";
import type { CueRules, SubtitleFormat } from "../render/subtitles.js";
import { assertTimelineFresh, joinTimelines, readTimeline, type Timeline, timelinePath, type TimelinePart, writeTimeline } from "../render/timeline.js";
import { lintStoryboard, type LoadedStyle, loadStoryboard, StoryboardError } from "../storyboard/load.js";
import { clipStoryboard } from "../storyboard/clip.js";
import { isBuiltinSfx, type Storyboard } from "../storyboard/schema.js";
import { probeVideo } from "../util/media.js";
import { makeTimer } from "../util/timing.js";
import { concatParts, type OutputSize, probePart, type Quality, trimVideo } from "./concat.js";
import { type Part, type Sequence, SequenceSchema, type Transition } from "./schema.js";

export interface LoadedSequence {
  seq: Sequence;
  path: string;
  baseDir: string;
}

export async function loadSequence(path: string): Promise<LoadedSequence> {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch (err) {
    throw new StoryboardError(`Cannot read ${abs}`, [(err as Error).message]);
  }
  const r = SequenceSchema.safeParse(raw);
  if (!r.success) {
    throw new StoryboardError(
      `Invalid sequence ${abs}`,
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return { seq: r.data, path: abs, baseDir: dirname(abs) };
}

const abs = (baseDir: string, p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));

/** A part with what it needs loaded: a storyboard is parsed; a nested sequence or a video is only located. */
export type LoadedPart =
  | { kind: "storyboard"; sb: Storyboard; baseDir: string }
  | { kind: "sequence"; file: string }
  | { kind: "video"; file: string };

/** The part as written in the sequence file, for messages. */
const partRef = (part: Part) => (part.storyboard ?? part.sequence ?? part.video)!;

/** `parts[i] (ref): message` for every issue of a failed part. */
const partIssues = (i: number, part: Part, err: StoryboardError) =>
  (err.issues.length ? err.issues : [err.message]).map((x) => `parts[${i}] (${partRef(part)}): ${x}`);

/**
 * Load every part; schema problems name the part, and a nested sequence that
 * leads back to one being loaded fails with the chain printed. `chain` is the
 * sequences being loaded, outermost first, this one included.
 */
export async function loadParts(loaded: LoadedSequence, chain: string[], style?: LoadedStyle): Promise<LoadedPart[]> {
  const issues: string[] = [];
  const parts: LoadedPart[] = [];
  for (const [i, part] of loaded.seq.parts.entries()) {
    if (part.sequence !== undefined) {
      const file = abs(loaded.baseDir, part.sequence);
      if (chain.includes(file)) {
        const root = dirname(chain[0]!);
        issues.push(`parts[${i}] (${part.sequence}): sequence includes itself: ${[...chain, file].map((c) => relative(root, c)).join(" → ")}`);
      }
      parts.push({ kind: "sequence", file });
    } else if (part.video !== undefined) {
      parts.push({ kind: "video", file: abs(loaded.baseDir, part.video) });
    } else {
      try {
        const { sb, baseDir } = await loadStoryboard(resolve(loaded.baseDir, part.storyboard!), { style });
        parts.push({ kind: "storyboard", sb, baseDir });
      } catch (err) {
        if (!(err instanceof StoryboardError)) throw err;
        issues.push(...partIssues(i, part, err));
      }
    }
  }
  if (issues.length) throw new StoryboardError(`Invalid sequence ${loaded.path}`, issues);
  return parts;
}

interface PreparedBase {
  index: number;
  /** Build folder of this part (keyed by index, so one storyboard can appear twice). */
  dir: string;
  /** Rendered video of this part. */
  output: string;
  /** Changes whenever this part, or a file it uses, changes. */
  key: string;
  /** How it enters from the previous part. */
  transition?: Transition;
  /** Folder name of the part's storyboard, the chapter of its lines in timeline.json. */
  chapter?: string;
}

export interface PreparedStoryboardPart extends PreparedBase {
  kind: "storyboard";
  /** The derived storyboard written for this part. */
  storyboard: string;
  /** Voice cache of the original storyboard, so parts share it with normal renders. */
  cacheDir: string;
  sb: Storyboard;
}

/** A nested sequence, rendered on its own to `output`. */
export interface PreparedSequencePart extends PreparedBase {
  kind: "sequence";
  sequence: PreparedSequence;
}

/** A finished video: used as is (`output` is the file itself) unless from/to trim it into the build folder. */
export interface PreparedVideoPart extends PreparedBase {
  kind: "video";
  file: string;
  from?: number;
  to?: number;
  /** A style cannot change a finished video; this says so when one was asked for. */
  warnings: string[];
}

export type PreparedPart = PreparedStoryboardPart | PreparedSequencePart | PreparedVideoPart;

export interface PreparedSequence {
  path: string;
  buildDir: string;
  output: OutputSize;
  parts: PreparedPart[];
  /** Name of the style applied to every storyboard part (see loadStyle); it names the default build folder and output. */
  style?: string;
  /** Changes whenever a part, a transition, the size or the style changes, so a nested sequence is re-rendered only then. */
  key: string;
}

/** The part's source range of its storyboard (the whole storyboard without from/to). */
export async function clipPart(loaded: LoadedSequence, index: number, sb: Storyboard, baseDir: string): Promise<Storyboard> {
  const { from, to, storyboard } = loaded.seq.parts[index]!;
  if (from === undefined && to === undefined) return sb;
  const { duration } = await probeVideo(resolve(baseDir, sb.source));
  try {
    return clipStoryboard(sb, { from, to }, duration);
  } catch (err) {
    throw new StoryboardError(`Invalid sequence ${loaded.path}`, [`parts[${index}] (${storyboard}): ${(err as Error).message}`]);
  }
}

/** A sound is a built-in name (`builtin:pop`, or `key`, `click`... in `sounds`) or a file; only a file has a path. */
const soundFile = (baseDir: string, p: string) => (p.startsWith("builtin:") || isBuiltinSfx(p) ? p : abs(baseDir, p));

async function fileStamp(file: string | undefined): Promise<string> {
  if (!file || !existsSync(file)) return "-";
  const st = await stat(file);
  return `${st.size}:${st.mtimeMs}`;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/**
 * Write one storyboard per part into the build folder: all at the same output
 * size, intro only on the first and outro only on the last, paths made
 * absolute. The user's files are never changed. Nested sequences are prepared
 * recursively (in their own build folder), videos are only probed.
 */
export async function prepareSequence(path: string, opts: { buildDir?: string; style?: LoadedStyle } = {}): Promise<PreparedSequence> {
  return prepare(path, opts, []);
}

async function prepare(path: string, opts: { buildDir?: string; style?: LoadedStyle }, ancestors: string[]): Promise<PreparedSequence> {
  const { style } = opts;
  const loaded = await loadSequence(path);
  const chain = [...ancestors, loaded.path];
  const loadedParts = await loadParts(loaded, chain, style);
  const buildDir = resolve(opts.buildDir ?? join(loaded.baseDir, `${basename(loaded.path, extname(loaded.path))}${style ? `.${style.name}` : ""}.build`));

  // Nested sequences first: the output size can come from the first part.
  const nested = new Map<number, PreparedSequence>();
  const videoInfo = new Map<number, Awaited<ReturnType<typeof probeVideo>>>();
  const issues: string[] = [];
  for (const [i, lp] of loadedParts.entries()) {
    const part = loaded.seq.parts[i]!;
    try {
      if (lp.kind === "sequence") nested.set(i, await prepare(lp.file, { style }, chain));
      else if (lp.kind === "video") {
        if (!existsSync(lp.file)) throw new StoryboardError("", [`video not found: ${lp.file}`]);
        videoInfo.set(i, await probeVideo(lp.file));
      }
    } catch (err) {
      if (!(err instanceof StoryboardError)) throw err;
      issues.push(...partIssues(i, part, err));
    }
  }
  if (issues.length) throw new StoryboardError(`Invalid sequence ${loaded.path}`, issues);

  const first = loadedParts[0]!;
  const firstOutput: Partial<OutputSize> =
    first.kind === "storyboard" ? first.sb.output : first.kind === "sequence" ? nested.get(0)!.output : sizeOf(videoInfo.get(0)!);
  const output: OutputSize = { ...firstOutput, ...loaded.seq.output } as OutputSize;
  const last = loadedParts.length - 1;

  const parts: PreparedPart[] = [];
  for (const [index, lp] of loadedParts.entries()) {
    const part = loaded.seq.parts[index]!;
    const dir = join(buildDir, `part-${index}`);
    await mkdir(dir, { recursive: true });
    const base = { index, dir, transition: part.transition, ...(part.storyboard !== undefined ? { chapter: basename(dirname(abs(loaded.baseDir, part.storyboard))) } : {}) };
    if (lp.kind === "sequence") {
      const sequence = nested.get(index)!;
      parts.push({ ...base, kind: "sequence", sequence, output: join(dir, "part.mp4"), key: sequence.key });
      continue;
    }
    if (lp.kind === "video") {
      const { from, to } = part;
      const trimmed = from !== undefined || to !== undefined;
      const key = sha1(`${lp.file}|${from ?? ""}|${to ?? ""}|${await fileStamp(lp.file)}`);
      const warnings = style ? [`style "${style.name}" is not applied to ${part.video} (a finished video)`] : [];
      parts.push({ ...base, kind: "video", file: lp.file, from, to, output: trimmed ? join(dir, "part.mp4") : lp.file, key, warnings });
      continue;
    }
    const { sb: loadedSb, baseDir } = lp;
    const original = await clipPart(loaded, index, loadedSb, baseDir);
    const sb: Storyboard = {
      ...original,
      source: abs(baseDir, original.source),
      events: original.events === undefined ? undefined : abs(baseDir, original.events),
      music: original.music && { ...original.music, src: abs(baseDir, original.music.src) },
      overlays: original.overlays.map((o) => ({ ...o, src: abs(baseDir, o.src) })),
      narration: original.narration.map((n) => (n.audio === undefined ? n : { ...n, audio: abs(baseDir, n.audio) })),
      sfx: original.sfx.map((x) => ({ ...x, src: soundFile(baseDir, x.src) })),
      sounds: original.sounds && {
        ...original.sounds,
        ...(typeof original.sounds.clicks === "string" ? { clicks: soundFile(baseDir, original.sounds.clicks) } : {}),
        ...(typeof original.sounds.typing === "string" ? { typing: soundFile(baseDir, original.sounds.typing) } : {}),
        ...(typeof original.sounds.cards === "string" ? { cards: soundFile(baseDir, original.sounds.cards) } : {}),
      },
      output,
      intro: index === 0 ? original.intro : undefined,
      outro: index === last ? original.outro : undefined,
    };
    const storyboard = join(dir, "storyboard.json");
    const text = JSON.stringify(sb, null, 2);
    await writeFile(storyboard, text);
    const sounds = [sb.sounds?.clicks, sb.sounds?.typing, sb.sounds?.cards].filter((x): x is string => typeof x === "string");
    const stamps = await Promise.all(
      [sb.source, sb.events, sb.music?.src, ...sb.overlays.map((o) => o.src), ...sb.narration.map((n) => n.audio), ...sb.sfx.map((x) => x.src), ...sounds].map(fileStamp),
    );
    const key = sha1(`${text}|${stamps.join("|")}`);
    parts.push({ ...base, kind: "storyboard", storyboard, output: join(dir, "part.mp4"), cacheDir: join(baseDir, CACHE_DIR), key, sb });
  }
  const key = sha1(JSON.stringify([output, parts.map((p) => [p.key, p.transition ?? null]), ...(style ? [style.name] : [])]));
  return { path: loaded.path, buildDir, output, parts, style: style?.name, key };
}

const sizeOf = (v: { width: number; height: number; fps: number }): OutputSize => ({ width: v.width, height: v.height, fps: Math.round(v.fps) });

export interface SequenceRenderOptions {
  /** A style file (see loadStyle) applied to every storyboard part; writes <sequence>.<style>.mp4. */
  style?: LoadedStyle;
  output?: string;
  quality?: Quality;
  buildDir?: string;
  pngFrames?: boolean;
  workers?: number;
  /** Log how long each stage takes. */
  timings?: boolean;
  /** Caption files for the joined video, from its timeline: `<output>.srt|vtt`, or `<output>.<code>.srt|vtt` per language (default formats srt and vtt). */
  subtitles?: SubtitleFormat[];
  subtitleLanguages?: SubtitleLanguage[];
  subtitleRules?: Partial<CueRules>;
  log?: (msg: string) => void;
  /** Told which part is rendering, for the live-job file. */
  onProgress?: (step: { label: string; index: number; total: number }) => void;
}

export interface SequenceResult {
  output: string;
  duration: number;
  join: "copy" | "encode";
  /** `<output>.timeline.json`: when each narration line and card is on screen in the joined video. */
  timeline: string;
  /** Caption files written next to the joined video (see `subtitles` / `subtitleLanguages`). */
  files?: string[];
  /** Translation keys that matched nothing, and the like. */
  warnings?: string[];
  /** `storyboard` is the derived storyboard of a storyboard part, else the nested sequence or video file. `cached` is also true for a video used as is. */
  parts: { kind: PreparedPart["kind"]; storyboard: string; output: string; duration: number; cached: boolean; warnings: string[] }[];
}

/** Render every part (reusing unchanged ones) and join them into one video. */
export async function renderSequence(path: string, opts: SequenceRenderOptions = {}): Promise<SequenceResult> {
  await checkTranslations(opts.subtitleLanguages);
  const prepared = await prepareSequence(path, opts);
  const quality = opts.quality ?? "looks";
  const job = startJob({ kind: "sequence", path: prepared.path, quality });
  const started = performance.now();
  const wall = () => Math.round(((performance.now() - started) / 1000) * 1000) / 1000;
  try {
    const r = await renderPrepared(prepared, { ...opts, onProgress: (step) => job.update(step) });
    if (opts.subtitles?.length || opts.subtitleLanguages?.length) {
      const subs = await writeTimelineSubtitles(await readTimeline(r.timeline), r.output, { languages: opts.subtitleLanguages ?? [], formats: opts.subtitles?.length ? opts.subtitles : ["srt", "vtt"], rules: opts.subtitleRules });
      for (const f of subs.files) (opts.log ?? (() => {}))(`wrote ${f}`);
      r.files = subs.files;
      r.warnings = subs.warnings;
    }
    await recordEvent({ kind: "sequence", status: "ok", path: prepared.path, output: r.output, durationSec: r.duration, quality, wallSeconds: wall() });
    return r;
  } catch (err) {
    await recordEvent({ kind: "sequence", status: "failed", path: prepared.path, quality, wallSeconds: wall(), error: (err as Error).message.slice(0, 500) });
    throw err;
  } finally {
    job.end();
  }
}

async function renderPrepared(prepared: PreparedSequence, opts: SequenceRenderOptions): Promise<SequenceResult> {
  const log = opts.log ?? (() => {});
  const quality = opts.quality ?? "looks";
  const results: SequenceResult["parts"] = [];
  for (const part of prepared.parts) {
    const label = `part ${part.index + 1}/${prepared.parts.length}`;
    const ref = part.kind === "storyboard" ? part.storyboard : part.kind === "sequence" ? part.sequence.path : part.file;
    if (part.kind === "video" && part.output === part.file) {
      log(`${label}: finished video, used as is`);
      results.push({ kind: part.kind, storyboard: ref, output: part.output, duration: 0, cached: true, warnings: part.warnings });
      continue;
    }
    const keyFile = join(part.dir, "part.key");
    const key = `${part.key}|${quality}|${opts.pngFrames ? "png" : "auto"}`;
    // A part keeps its timeline next to its video (part.timeline.json), so a cached part still has one; without it (cached by an older version) it is rendered again.
    const hasTimeline = part.kind === "video" || existsSync(timelinePath(part.output));
    const cached = existsSync(part.output) && hasTimeline && existsSync(keyFile) && (await readFile(keyFile, "utf8")) === key;
    let warnings: string[] = part.kind === "video" ? part.warnings : [];
    opts.onProgress?.({ label: "part", index: part.index + 1, total: prepared.parts.length });
    if (cached) log(`${label}: unchanged, reusing ${part.output}`);
    else {
      log(`${label}: rendering`);
      if (part.kind === "storyboard") {
        const r = await renderStoryboard(part.storyboard, {
          buildDir: join(part.dir, "build"),
          cacheDir: part.cacheDir,
          output: part.output,
          quality,
          pngFrames: opts.pngFrames,
          workers: opts.workers,
          timings: opts.timings,
          log,
          history: false,
        });
        warnings = r.warnings;
      } else if (part.kind === "sequence") {
        const r = await renderPrepared(part.sequence, { ...opts, output: part.output, buildDir: undefined, onProgress: undefined });
        warnings = r.parts.flatMap((p) => p.warnings);
      } else {
        await trimVideo(part.file, part.output, { from: part.from, to: part.to }, quality);
      }
      await writeFile(keyFile, key);
    }
    results.push({ kind: part.kind, storyboard: ref, output: part.output, duration: 0, cached, warnings });
  }

  const media = await Promise.all(
    prepared.parts.map(async (p) => ({ ...(await probePart(p.output)), transition: p.transition })),
  );
  media.forEach((m, i) => (results[i]!.duration = m.duration));
  const base = prepared.path.slice(0, -extname(prepared.path).length);
  const output = resolve(opts.output ?? `${base}${prepared.style ? `.${prepared.style}` : ""}.mp4`);
  await mkdir(dirname(output), { recursive: true });
  const joined = await makeTimer(opts.timings, log)("join", () =>
    concatParts(media, output, prepared.output, { workDir: prepared.buildDir, quality, log }),
  );
  const duration = (await probeVideo(output)).duration;
  const timelines: TimelinePart[] = [];
  for (const [i, part] of prepared.parts.entries()) {
    timelines.push({ timeline: await partTimeline(part, media[i]!.duration), duration: media[i]!.duration, transition: part.transition, part: i, chapter: part.chapter });
  }
  const timelineFile = timelinePath(output);
  await writeTimeline(timelineFile, { ...joinTimelines(timelines, prepared.output.fps), duration: Math.round(duration * 1000) / 1000 });
  log(`wrote ${timelineFile}`);
  return { output, timeline: timelineFile, duration, join: joined.mode, parts: results };
}

/**
 * The timeline of a rendered part (see `part.timeline.json`, written by the render that made it), checked against the
 * part's real length. A finished video brings its own `<video>.timeline.json` when it has one; trimmed, it has none.
 */
async function partTimeline(part: PreparedPart, videoDuration: number): Promise<Timeline> {
  if (part.kind === "video") {
    const file = timelinePath(part.file);
    if (part.output !== part.file || !existsSync(file)) return { version: 1, duration: videoDuration, items: [] };
    const timeline = await readTimeline(file);
    assertTimelineFresh(file, timeline, videoDuration);
    return timeline;
  }
  const file = timelinePath(part.output);
  const timeline = await readTimeline(file);
  assertTimelineFresh(file, timeline, videoDuration);
  return timeline;
}

/** Schema problems throw (StoryboardError with issues); everything else is a warning. */
export async function validateSequence(path: string): Promise<{ valid: true; warnings: string[] }> {
  return validate(path, []);
}

async function validate(path: string, ancestors: string[]): Promise<{ valid: true; warnings: string[] }> {
  const loaded = await loadSequence(path);
  const chain = [...ancestors, loaded.path];
  const loadedParts = await loadParts(loaded, chain);
  const warnings: string[] = [];
  const issues: string[] = [];
  for (const [i, lp] of loadedParts.entries()) {
    const part = loaded.seq.parts[i]!;
    const label = `parts[${i}] (${partRef(part)})`;
    if (lp.kind === "sequence") {
      try {
        warnings.push(...(await validate(lp.file, chain)).warnings.map((w) => `${label}: ${w}`));
      } catch (err) {
        if (!(err instanceof StoryboardError)) throw err;
        issues.push(...partIssues(i, part, err));
      }
      continue;
    }
    const src = lp.kind === "video" ? lp.file : resolve(lp.baseDir, lp.sb.source);
    const what = lp.kind === "video" ? "video" : "source";
    if (!existsSync(src)) {
      warnings.push(`${label}: ${what} not found: ${src}`);
      continue;
    }
    const { duration } = await probeVideo(src);
    const { from, to } = part;
    if (to !== undefined && to > duration + 0.01) warnings.push(`${label}: to ${to}s is past the end of the ${what} (${duration.toFixed(2)}s)`);
    if (lp.kind === "video") {
      if (from !== undefined && from >= duration) issues.push(`${label}: keeps nothing: from ${from}s is past the end of the video (${duration.toFixed(2)}s)`);
      continue;
    }
    warnings.push(...lintStoryboard(lp.sb, duration).map((w) => `${label}: ${w}`));
    try {
      await clipPart(loaded, i, lp.sb, lp.baseDir);
    } catch (err) {
      if (!(err instanceof StoryboardError)) throw err;
      issues.push(...err.issues);
    }
  }
  if (issues.length) throw new StoryboardError(`Invalid sequence ${loaded.path}`, issues);
  return { valid: true, warnings };
}
