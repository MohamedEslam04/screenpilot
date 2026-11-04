import { rename, rm } from "node:fs/promises";
import { extname } from "node:path";
import { run } from "../util/exec.js";
import { probeVideo } from "../util/media.js";

// Loudness normalization of the finished video: two-pass EBU R128 `loudnorm`.
// Pass one measures the mix, pass two applies the measured values as a plain
// gain (linear), so the dynamics are left alone. The picture is copied.

export interface LoudnessTarget {
  target: number;
  truePeak: number;
}

export interface Measured {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

// LRA 50 (the largest ffmpeg takes) keeps loudnorm in linear mode, a plain gain, however wide the dynamics are.
const LRA = 50;
const head = (t: LoudnessTarget) => `loudnorm=I=${t.target}:TP=${t.truePeak}:LRA=${LRA}`;

export function buildMeasureArgs(file: string, t: LoudnessTarget): string[] {
  return ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `${head(t)}:print_format=json`, "-f", "null", "-"];
}

/** The measurement from loudnorm's JSON block in ffmpeg's log; undefined for silence or no block. */
export function parseLoudnorm(log: string): Measured | undefined {
  const blocks = log.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  const block = blocks?.at(-1);
  if (!block) return undefined;
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(block) as Record<string, string>;
  } catch {
    return undefined;
  }
  const num = (k: string) => Number(raw[k]);
  const m = {
    input_i: num("input_i"),
    input_tp: num("input_tp"),
    input_lra: num("input_lra"),
    input_thresh: num("input_thresh"),
    target_offset: num("target_offset"),
  };
  return Object.values(m).every(Number.isFinite) ? m : undefined;
}

export function buildLoudnormArgs(input: string, output: string, t: LoudnessTarget, m: Measured): string[] {
  const filter =
    `${head(t)}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true,aresample=48000`;
  // aac and faststart belong to the MP4 family; WebM takes Opus and has no movflags.
  const ext = extname(output).toLowerCase();
  const audio = ext === ".webm" ? ["-c:a", "libopus", "-b:a", "160k"] : ["-c:a", "aac", "-b:a", "192k"];
  const flags = [".mp4", ".m4v", ".mov"].includes(ext) ? ["-movflags", "+faststart"] : [];
  return ["-y", "-loglevel", "error", "-i", input, "-c:v", "copy", "-af", filter, ...audio, ...flags, output];
}

export interface LoudnessResult {
  applied: boolean;
  /** Why nothing was done. */
  reason?: string;
  measured?: Measured;
}

/** Normalize `file` in place. Does nothing for a video without sound or a silent mix. */
export async function normalizeLoudness(file: string, t: LoudnessTarget): Promise<LoudnessResult> {
  if (!(await probeVideo(file)).hasAudio) return { applied: false, reason: "the video has no audio track" };
  const { stderr } = await run("ffmpeg", buildMeasureArgs(file, t));
  const measured = parseLoudnorm(stderr);
  if (!measured) return { applied: false, reason: "the audio is silent, so there is nothing to normalize" };
  const tmp = file.replace(/(\.[^./\\]+)?$/, ".norm$1");
  try {
    await run("ffmpeg", buildLoudnormArgs(file, tmp, t, measured));
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { applied: true, measured };
}
