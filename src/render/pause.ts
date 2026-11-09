import { statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { APP } from "../brand.js";
import { type JobInfo, listJobs } from "../history/jobs.js";
import { currentScope } from "../util/proc.js";

// Pause between parts (and chunks) of a long render. The request is a flag on the
// render's process scope (src/util/proc.ts, next to `aborted`): pauseAll sets it in
// this process, and `pause` from another process drops a `.pause` file into the build
// folder, which the render turns into the flag. The render looks before each part
// or chunk it is about to render, stops cleanly there and writes `.paused.json`
// with the options it ran with, so `resume` renders the same thing again: every
// finished part and chunk is a cache hit.

/** Dropped into a build folder to ask the render using it to stop at the next part or chunk. */
export const PAUSE_FILE = ".pause";
/** Written by a render that stopped on a pause: what `resume` needs. */
export const PAUSED_STATE_FILE = ".paused.json";

/** A request this much older than the render's start is stale (coarse file times), not for this render. */
const STALE_SLACK_MS = 1000;

/** The options a paused render ran with (JSON: a style by its file). */
export interface ResumeOptions {
  output?: string;
  quality?: "draft" | "looks" | "delivery";
  /** Style file path. */
  style?: string;
  workers?: number;
  pngFrames?: boolean;
  timings?: boolean;
  buildDir?: string;
  minFreeMemMB?: number;
  memTimeoutS?: number;
  /** The variant as given: a name for a sequence (and its shared folder), a file or name for a single render. */
  variant?: string;
  variantDir?: string;
  /** Slot-fit options (see FitOptions). */
  fit?: { auto?: boolean; strict?: boolean; max?: number };
  /** Caption files and languages ({code, file?}) and cue rules. */
  subtitles?: ("srt" | "vtt")[];
  subtitleLanguages?: { code: string; file?: string }[];
  subtitleRules?: Record<string, number>;
  // A single render only:
  window?: { from: number; to?: number };
  size?: { width: number; height: number };
  chunks?: boolean;
  chunkSeconds?: number;
  also?: ("gif" | "webm" | "poster")[];
  posterAt?: number;
}

export interface PausedState {
  version: 1;
  kind: "render" | "sequence";
  /** The storyboard or sequence file. */
  path: string;
  buildDir: string;
  pausedAt: string;
  options: ResumeOptions;
}

export interface PausedPart {
  /** 1-based, as in the log ("part 2/8"). */
  part: number;
  status: "done" | "in progress" | "waiting";
  /** Chunks of a part that stopped between them. */
  chunks?: { done: number; total: number };
}

/** What a paused render or sequence tells its caller. */
export interface PausedInfo {
  paused: true;
  kind: "render" | "sequence";
  path: string;
  buildDir: string;
  /** Sequence: parts finished and how many there are. */
  partsDone?: number;
  partsTotal?: number;
  parts?: PausedPart[];
  /** A long single render: chunks finished (cached) and how many there are. */
  chunks?: { done: number; total: number };
  /** Where the options for resume were saved. */
  stateFile?: string;
  /** The command that carries on (MCP: the resume tool with the same path). */
  resume: string;
}

/** Thrown by a render or sequence that stopped on a pause request; `info` is the result to show. Not a failure. */
export class RenderPaused extends Error {
  constructor(readonly info: PausedInfo) {
    super(`paused: ${info.path}; carry on with: ${info.resume}`);
    this.name = "RenderPaused";
  }
}

export const resumeCommand = (path: string) => `${APP} resume ${path}`;

/**
 * Was a pause asked for since this render started? The flag lives on the render's process
 * scope (next to `aborted`; pauseAll sets it in this process); a `.pause` file in the build
 * folder is how another process asks, and seeing one sets the flag. A file from before the
 * render started is stale (nothing was listening then).
 */
export function pauseRequested(buildDir: string, since: number): boolean {
  const scope = currentScope();
  if (scope?.pauseRequested) return true;
  try {
    if (statSync(join(buildDir, PAUSE_FILE)).mtimeMs < since - STALE_SLACK_MS) return false;
  } catch {
    return false;
  }
  if (scope) scope.pauseRequested = true;
  return true;
}

/** The build folders of a storyboard or sequence: `<name>.build` and `<name>.<style|format|part-…>.build` next to it. */
async function buildDirsOf(path: string): Promise<string[]> {
  const abs = resolve(path);
  const dir = dirname(abs);
  const base = basename(abs, extname(abs));
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith(".build") && (e.name === `${base}.build` || e.name.startsWith(`${base}.`)))
    .map((e) => join(dir, e.name));
}

/**
 * Ask the render of `path` (or the one using `buildDir`) to pause: writes `.pause`
 * into each of its build folders (the one in use is among them; a render that is
 * not running ignores it, see pauseRequested). Returns the folders written.
 */
export async function requestPause(target: { path?: string; buildDir?: string }): Promise<string[]> {
  let dirs: string[];
  if (target.buildDir) dirs = [resolve(target.buildDir)];
  else if (target.path) {
    dirs = await buildDirsOf(target.path);
    // A render that is still preparing (voice, cut) may not have made its folder yet.
    if (!dirs.length) dirs = [join(dirname(resolve(target.path)), `${basename(target.path, extname(target.path))}.build`)];
  } else throw new Error("pause needs a path or a build folder");
  const body = JSON.stringify({ requestedAt: new Date().toISOString() });
  for (const d of dirs) {
    await mkdir(d, { recursive: true });
    await writeFile(join(d, PAUSE_FILE), body);
  }
  return dirs;
}

/** Save what resume needs, and use up the pause request. Returns the state file. */
export async function writePausedState(state: PausedState): Promise<string> {
  const file = join(state.buildDir, PAUSED_STATE_FILE);
  await mkdir(state.buildDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
  await rm(join(state.buildDir, PAUSE_FILE), { force: true });
  return file;
}

/** A render that finished leaves no pause behind. */
export async function clearPause(buildDir: string): Promise<void> {
  await rm(join(buildDir, PAUSED_STATE_FILE), { force: true });
  await rm(join(buildDir, PAUSE_FILE), { force: true });
}

async function readState(buildDir: string): Promise<PausedState | undefined> {
  try {
    const s = JSON.parse(await readFile(join(buildDir, PAUSED_STATE_FILE), "utf8")) as PausedState;
    return s.version === 1 && (s.kind === "render" || s.kind === "sequence") ? s : undefined;
  } catch {
    return undefined;
  }
}

/** The paused render of `path` (in `buildDir`, or the newest among its build folders), if any. */
export async function findPausedState(path: string, buildDir?: string): Promise<PausedState | undefined> {
  const abs = resolve(path);
  const states = (await Promise.all((buildDir ? [resolve(buildDir)] : await buildDirsOf(abs)).map(readState))).filter(
    (s): s is PausedState => s !== undefined && resolve(s.path) === abs,
  );
  return states.sort((a, b) => b.pausedAt.localeCompare(a.pausedAt))[0];
}

/**
 * The `pause` command: ask the render of `path` (or `buildDir`) to pause, or, with
 * neither, every render and sequence running now (from the live-job files).
 * The renders stop at their next part or chunk; `running` lists the ones known to run.
 */
export async function pauseRenders(
  target: { path?: string; buildDir?: string },
  jobs: JobInfo[] = listJobs(),
): Promise<{ requested: string[]; running: { kind: JobInfo["kind"]; path: string }[] }> {
  const running = jobs.map((j) => ({ kind: j.kind, path: j.path }));
  if (target.path || target.buildDir) {
    const abs = target.path ? resolve(target.path) : undefined;
    return { requested: await requestPause(target), running: abs ? running.filter((j) => resolve(j.path) === abs) : running };
  }
  if (!running.length) throw new Error("Nothing is rendering now. Give the storyboard or sequence to pause (or --build-dir).");
  const requested: string[] = [];
  for (const j of running) requested.push(...(await requestPause({ path: j.path })));
  return { requested: [...new Set(requested)], running };
}
