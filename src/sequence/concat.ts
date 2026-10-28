import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/exec.js";
import { ffmpegFilterScriptFlag } from "../util/media.js";

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

/** Joining by stream copy is only safe when every part was encoded the same way. */
export function canStreamCopy(parts: PartMedia[]): boolean {
  return parts.every((p) => p.signature === parts[0]!.signature);
}

/**
 * Filter graph that brings every part to the same size, frame rate and audio
 * layout, then joins them in order. A part without audio gets silence of its
 * length, so it can sit between parts that have sound.
 */
export function buildConcatFilter(
  parts: { duration: number; hasAudio: boolean }[],
  out: OutputSize,
): { filter: string; audio: boolean; duration: number } {
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
  const ins = parts.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  lines.push(`${ins}concat=n=${parts.length}:v=1:a=${audio ? 1 : 0}${audio ? "[vout][aout]" : "[vout]"}`);
  return { filter: lines.join(";\n"), audio, duration: parts.reduce((s, p) => s + p.duration, 0) };
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
  parts: PartMedia[],
  output: string,
  out: OutputSize,
  opts: ConcatOptions,
): Promise<{ output: string; mode: "copy" | "encode" }> {
  const log = opts.log ?? (() => {});
  if (canStreamCopy(parts)) {
    log(`join: ${parts.length} part(s), stream copy`);
    const list = join(opts.workDir, "concat.txt");
    await writeFile(list, parts.map((p) => `file '${p.file.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
    return { output, mode: "copy" };
  }
  log(`join: ${parts.length} part(s), re-encoding (parts differ in format)`);
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
