import { run } from "./exec.js";

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height,avg_frame_rate,r_frame_rate:format=duration",
    "-of",
    "json",
    file,
  ]);
  const data = JSON.parse(stdout) as {
    streams: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    format: { duration?: string };
  };
  const v = data.streams.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error(`No video stream in ${file}`);
  let duration = Number(data.format.duration);
  if (!Number.isFinite(duration)) {
    // Matroska from OBS sometimes lacks a container duration until remuxed.
    duration = await probeDurationByDecode(file);
  }
  return {
    width: v.width,
    height: v.height,
    duration,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30,
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`Cannot read duration of ${file}`);
  return d;
}

async function probeDurationByDecode(file: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-map", "0:v:0", "-f", "null", "-"]);
  const matches = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = matches.at(-1);
  if (!last) throw new Error(`Cannot read duration of ${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

function parseRate(r?: string): number {
  if (!r) return 0;
  const [a, b] = r.split("/").map(Number);
  if (!a) return 0;
  return b ? a / b : a;
}

let scriptFlag: string | undefined;

/** ffmpeg 7 deprecated -filter_complex_script in favour of -/filter_complex. */
export async function ffmpegFilterScriptFlag(): Promise<string> {
  if (scriptFlag) return scriptFlag;
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-version"]);
  const major = Number(/ffmpeg version n?(\d+)/.exec(stdout)?.[1] ?? 0);
  scriptFlag = major >= 7 ? "-/filter_complex" : "-filter_complex_script";
  return scriptFlag;
}

/** Extract one frame per time as JPEG (times in source seconds). */
export async function extractFrames(
  file: string,
  times: number[],
  outPath: (t: number) => string,
  width = 1280,
): Promise<string[]> {
  const paths: string[] = [];
  for (const t of times) {
    const p = outPath(t);
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2`,
      "-pix_fmt", "yuvj420p", "-q:v",
      "3",
      p,
    ]);
    paths.push(p);
  }
  return paths;
}
