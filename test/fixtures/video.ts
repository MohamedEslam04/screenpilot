import { execFileSync } from "node:child_process";

/** A small test video: moving test pattern, optionally with a tone. */
export function makeVideo(file: string, dur: number, opts: { audio?: boolean; size?: string; fps?: number } = {}): string {
  const fps = opts.fps ?? 30;
  const args = ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=s=${opts.size ?? "320x180"}:d=${dur}:r=${fps}`];
  if (opts.audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`, "-c:a", "aac", "-ac", "2", "-ar", "48000");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", String(fps), "-shortest", file);
  execFileSync("ffmpeg", args);
  return file;
}
