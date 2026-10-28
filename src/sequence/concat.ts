import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/exec.js";
import { ffmpegFilterScriptFlag } from "../util/media.js";
import type { Transition } from "./schema.js";

export interface OutputSize {
  width: number;
  height: number;
  fps: number;
}

export interface PartMedia {
  file: string;
  /** Video stream length (s); the joins are timed on it. */
  duration: number;
  hasAudio: boolean;
  /** Codec parameters; parts with equal signatures can be joined without re-encoding. */
  signature: string;
}

export type Quality = "draft" | "looks" | "delivery";

const f = (n: number) => n.toFixed(3);

export async function probePart(file: string): Promise<PartMedia> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,time_base,sample_rate,channels,channel_layout,duration:format=duration",
    "-of",
    "json",
    file,
  ]);
  const data = JSON.parse(stdout) as { streams: Record<string, string | number | undefined>[]; format: { duration?: string } };
  const v = data.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error(`No video stream in ${file}`);
  const a = data.streams.find((s) => s.codec_type === "audio");
  const pick = (s: Record<string, unknown> | undefined, keys: string[]) => (s ? keys.map((k) => s[k] ?? "") : ["none"]);
  const signature = JSON.stringify([
    pick(v, ["codec_name", "profile", "width", "height", "pix_fmt", "r_frame_rate", "time_base"]),
    pick(a, ["codec_name", "profile", "sample_rate", "channels", "channel_layout", "time_base"]),
  ]);
  const duration = Number(v.duration ?? data.format.duration);
  if (!Number.isFinite(duration)) throw new Error(`Cannot read duration of ${file}`);
  return { file, duration, hasAudio: !!a, signature };
}

/** A part and how it enters from the previous one. */
export type JoinPart = PartMedia & { transition?: Transition };

const XFADE: Record<Exclude<Transition["type"], "cut">, string> = {
  crossfade: "fade",
  "fade-black": "fadeblack",
  "wipe-left": "wipeleft",
  "wipe-right": "wiperight",
  "slide-left": "slideleft",
  "slide-right": "slideright",
};

/**
 * Seconds each part overlaps the one before it: its transition's length, at
 * most half of either neighbour (0 for cuts and for the first part).
 */
export function transitionOverlaps(parts: { duration: number; transition?: Transition }[], fps: number): number[] {
  return parts.map((p, i) => {
    const t = p.transition;
    if (i === 0 || !t || t.type === "cut") return 0;
    const d = Math.min(t.dur, parts[i - 1]!.duration / 2, p.duration / 2);
    return d < 1 / fps ? 0 : Math.round(d * 1000) / 1000;
  });
}

/** Joining by stream copy is only safe for plain cuts between parts encoded the same way. */
export function canStreamCopy(parts: JoinPart[], fps: number): boolean {
  return transitionOverlaps(parts, fps).every((o) => o === 0) && parts.every((p) => p.signature === parts[0]!.signature);
}

/**
 * Filter graph that brings every part to the same size, frame rate and audio
 * layout, then joins them in order: plain cuts with concat, transitions with
 * xfade/acrossfade (offsets from the real part durations). A part without
 * audio gets silence of its length, so it can sit between parts that have sound.
 */
export function buildConcatFilter(
  parts: { duration: number; hasAudio: boolean; transition?: Transition }[],
  out: OutputSize,
): { filter: string; audio: boolean; duration: number; overlaps: number[] } {
  const { width: w, height: h, fps } = out;
  const audio = parts.some((p) => p.hasAudio);
  const lines: string[] = [];
  parts.forEach((p, i) => {
    lines.push(
      `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,` +
        `trim=duration=${f(p.duration)}[v${i}]`,
    );
    if (!audio) return;
    const src = p.hasAudio ? `[${i}:a]aresample=48000,asetpts=PTS-STARTPTS,apad,` : "anullsrc=r=48000:cl=stereo,";
    lines.push(`${src}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${f(p.duration)}[a${i}]`);
  });
  const overlaps = transitionOverlaps(parts, fps);
  const duration = parts.reduce((s, p, i) => s + p.duration - overlaps[i]!, 0);
  if (overlaps.every((o) => o === 0)) {
    const ins = parts.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
    lines.push(`${ins}concat=n=${parts.length}:v=1:a=${audio ? 1 : 0}${audio ? "[vout][aout]" : "[vout]"}`);
    return { filter: lines.join(";\n"), audio, duration, overlaps };
  }

  // Fold the parts in one by one; `length` is the joined length so far.
  let v = "[v0]";
  let a = "[a0]";
  let length = parts[0]!.duration;
  for (let i = 1; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const nv = last ? "[vout]" : `[xv${i}]`;
    const na = last ? "[aout]" : `[xa${i}]`;
    const o = overlaps[i]!;
    if (o === 0) {
      lines.push(`${v}[v${i}]concat=n=2:v=1:a=0${nv}`);
      if (audio) lines.push(`${a}[a${i}]concat=n=2:v=0:a=1${na}`);
    } else {
      const type = parts[i]!.transition!.type as keyof typeof XFADE;
      lines.push(`${v}[v${i}]xfade=transition=${XFADE[type]}:duration=${f(o)}:offset=${f(length - o)}${nv}`);
      if (audio) lines.push(`${a}[a${i}]acrossfade=d=${f(o)}${na}`);
    }
    length += parts[i]!.duration - o;
    v = nv;
    a = na;
  }
  return { filter: lines.join(";\n"), audio, duration, overlaps };
}

const ENCODE: Record<Quality, string[]> = {
  draft: ["-preset", "veryfast", "-crf", "23"],
  looks: ["-preset", "medium", "-crf", "18"],
  delivery: ["-preset", "slow", "-crf", "16"],
};

export interface ConcatOptions {
  /** Where the list / filter files go. */
  workDir: string;
  quality?: Quality;
  log?: (msg: string) => void;
}

/** Join rendered parts into one MP4: stream copy when possible, else re-encode. */
export async function concatParts(
  parts: JoinPart[],
  output: string,
  out: OutputSize,
  opts: ConcatOptions,
): Promise<{ output: string; mode: "copy" | "encode" }> {
  const log = opts.log ?? (() => {});
  if (canStreamCopy(parts, out.fps)) {
    log(`join: ${parts.length} part(s), stream copy`);
    const list = join(opts.workDir, "concat.txt");
    await writeFile(list, parts.map((p) => `file '${p.file.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
    return { output, mode: "copy" };
  }
  log(`join: ${parts.length} part(s), re-encoding (transitions, or parts differ in format)`);
  const { filter, audio } = buildConcatFilter(parts, out);
  const filterPath = join(opts.workDir, "concat.filter");
  await writeFile(filterPath, filter);
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    ...parts.flatMap((p) => ["-i", p.file]),
    await ffmpegFilterScriptFlag(),
    filterPath,
    "-map",
    "[vout]",
    ...(audio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-c:v",
    "libx264",
    ...ENCODE[opts.quality ?? "looks"],
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(out.fps),
    "-movflags",
    "+faststart",
    output,
  ]);
  return { output, mode: "encode" };
}
