import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { CACHE_DIR } from "../brand.js";
import { renderStoryboard } from "../render/index.js";
import { lintStoryboard, loadStoryboard, StoryboardError } from "../storyboard/load.js";
import type { Storyboard } from "../storyboard/schema.js";
import { probeVideo } from "../util/media.js";
import { concatParts, type OutputSize, probePart, type Quality } from "./concat.js";
import { type Sequence, SequenceSchema } from "./schema.js";

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

/** Load every part's storyboard; schema problems name the part. */
async function loadParts(loaded: LoadedSequence) {
  const issues: string[] = [];
  const parts = [];
  for (const [i, part] of loaded.seq.parts.entries()) {
    try {
      parts.push(await loadStoryboard(resolve(loaded.baseDir, part.storyboard)));
    } catch (err) {
      if (!(err instanceof StoryboardError)) throw err;
      issues.push(...(err.issues.length ? err.issues : [err.message]).map((x) => `parts[${i}] (${part.storyboard}): ${x}`));
    }
  }
  if (issues.length) throw new StoryboardError(`Invalid sequence ${loaded.path}`, issues);
  return parts;
}

export interface PreparedPart {
  index: number;
  /** Build folder of this part (keyed by index, so one storyboard can appear twice). */
  dir: string;
  /** The derived storyboard written for this part. */
  storyboard: string;
  /** Rendered video of this part. */
  output: string;
  /** Voice cache of the original storyboard, so parts share it with normal renders. */
  cacheDir: string;
  /** Changes whenever the derived storyboard or a file it uses changes. */
  key: string;
  sb: Storyboard;
}

export interface PreparedSequence {
  path: string;
  buildDir: string;
  output: OutputSize;
  parts: PreparedPart[];
}

const abs = (baseDir: string, p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));

async function fileStamp(file: string | undefined): Promise<string> {
  if (!file || !existsSync(file)) return "-";
  const st = await stat(file);
  return `${st.size}:${st.mtimeMs}`;
}

/**
 * Write one storyboard per part into the build folder: all at the same output
 * size, intro only on the first and outro only on the last, paths made
 * absolute. The user's files are never changed.
 */
export async function prepareSequence(path: string, opts: { buildDir?: string } = {}): Promise<PreparedSequence> {
  const loaded = await loadSequence(path);
  const storyboards = await loadParts(loaded);
  const buildDir = resolve(opts.buildDir ?? join(loaded.baseDir, `${basename(loaded.path, extname(loaded.path))}.build`));
  const output: OutputSize = { ...storyboards[0]!.sb.output, ...loaded.seq.output };
  const last = storyboards.length - 1;

  const parts: PreparedPart[] = [];
  for (const [index, { sb: original, baseDir }] of storyboards.entries()) {
    const sb: Storyboard = {
      ...original,
      source: abs(baseDir, original.source),
      events: original.events === undefined ? undefined : abs(baseDir, original.events),
      music: original.music && { ...original.music, src: abs(baseDir, original.music.src) },
      output,
      intro: index === 0 ? original.intro : undefined,
      outro: index === last ? original.outro : undefined,
    };
    const dir = join(buildDir, `part-${index}`);
    await mkdir(dir, { recursive: true });
    const storyboard = join(dir, "storyboard.json");
    const text = JSON.stringify(sb, null, 2);
    await writeFile(storyboard, text);
    const stamps = await Promise.all([sb.source, sb.events, sb.music?.src].map(fileStamp));
    const key = createHash("sha1").update(`${text}|${stamps.join("|")}`).digest("hex");
    parts.push({ index, dir, storyboard, output: join(dir, "part.mp4"), cacheDir: join(baseDir, CACHE_DIR), key, sb });
  }
  return { path: loaded.path, buildDir, output, parts };
}

export interface SequenceRenderOptions {
  output?: string;
  quality?: Quality;
  buildDir?: string;
  pngFrames?: boolean;
  workers?: number;
  log?: (msg: string) => void;
}

export interface SequenceResult {
  output: string;
  duration: number;
  join: "copy" | "encode";
  parts: { storyboard: string; output: string; duration: number; cached: boolean; warnings: string[] }[];
}

/** Render every part (reusing unchanged ones) and join them into one video. */
export async function renderSequence(path: string, opts: SequenceRenderOptions = {}): Promise<SequenceResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareSequence(path, opts);
  const quality = opts.quality ?? "looks";
  const results: SequenceResult["parts"] = [];
  for (const part of prepared.parts) {
    const keyFile = join(part.dir, "part.key");
    const key = `${part.key}|${quality}|${opts.pngFrames ? "png" : "auto"}`;
    const cached = existsSync(part.output) && existsSync(keyFile) && (await readFile(keyFile, "utf8")) === key;
    let warnings: string[] = [];
    if (cached) log(`part ${part.index + 1}/${prepared.parts.length}: unchanged, reusing ${part.output}`);
    else {
      log(`part ${part.index + 1}/${prepared.parts.length}: rendering`);
      const r = await renderStoryboard(part.storyboard, {
        buildDir: join(part.dir, "build"),
        cacheDir: part.cacheDir,
        output: part.output,
        quality,
        pngFrames: opts.pngFrames,
        workers: opts.workers,
        log,
      });
      warnings = r.warnings;
      await writeFile(keyFile, key);
    }
    results.push({ storyboard: part.storyboard, output: part.output, duration: 0, cached, warnings });
  }

  const media = await Promise.all(prepared.parts.map((p) => probePart(p.output)));
  media.forEach((m, i) => (results[i]!.duration = m.duration));
  const base = prepared.path.slice(0, -extname(prepared.path).length);
  const output = resolve(opts.output ?? `${base}.mp4`);
  await mkdir(dirname(output), { recursive: true });
  const joined = await concatParts(media, output, prepared.output, { workDir: prepared.buildDir, quality, log });
  return { output, duration: (await probeVideo(output)).duration, join: joined.mode, parts: results };
}

/** Schema problems throw (StoryboardError with issues); everything else is a warning. */
export async function validateSequence(path: string): Promise<{ valid: true; warnings: string[] }> {
  const loaded = await loadSequence(path);
  const storyboards = await loadParts(loaded);
  const warnings: string[] = [];
  for (const [i, { sb, baseDir }] of storyboards.entries()) {
    const label = `parts[${i}] (${loaded.seq.parts[i]!.storyboard})`;
    const src = resolve(baseDir, sb.source);
    const found = existsSync(src) ? lintStoryboard(sb, (await probeVideo(src)).duration) : [`source not found: ${src}`];
    warnings.push(...found.map((w) => `${label}: ${w}`));
  }
  return { valid: true, warnings };
}
