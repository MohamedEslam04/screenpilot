import { extname } from "node:path";
import { run } from "../util/exec.js";
import { probeVideo } from "../util/media.js";

// Extra files made from the finished MP4: an animated GIF (README, chat), a WebM, a poster frame.

export type ExtraFormat = "gif" | "webm" | "poster";

export function parseExtras(value: string | string[] | undefined): ExtraFormat[] {
  if (value === undefined) return [];
  const list = (Array.isArray(value) ? value : value.split(",")).map((f) => f.trim().toLowerCase()).filter(Boolean);
  const out: ExtraFormat[] = [];
  for (const f of list) {
    if (f !== "gif" && f !== "webm" && f !== "poster") throw new Error(`unknown extra output "${f}" (use gif, webm, poster, or a comma list)`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** `<video without extension>.gif` / `.webm` / `.poster.png`. */
export function extraPath(video: string, kind: ExtraFormat): string {
  const base = video.slice(0, video.length - extname(video).length);
  return kind === "poster" ? `${base}.poster.png` : `${base}.${kind}`;
}

export function buildGifArgs(input: string, output: string, o: { width: number; fps: number }): string[] {
  // One pass: the palette is built from the clip itself. -2 keeps the height even; min() never scales up.
  const filter = `fps=${o.fps},scale=min(${o.width}\\,iw):-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  return ["-y", "-loglevel", "error", "-i", input, "-vf", filter, "-an", "-loop", "0", output];
}

export function buildWebmArgs(input: string, output: string): string[] {
  return ["-y", "-loglevel", "error", "-i", input, "-map", "0:v", "-map", "0:a?", "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-c:a", "libopus", "-b:a", "96k", output];
}

/** Where the poster frame is taken: `at` kept inside the video, by default a quarter of the way in. */
export function posterTime(duration: number, at: number | undefined): number {
  if (at === undefined) return Math.round(duration * 25) / 100;
  return Math.round(Math.min(Math.max(0, at), Math.max(0, duration - 0.1)) * 1000) / 1000;
}

export function buildPosterArgs(input: string, output: string, at: number): string[] {
  return ["-y", "-loglevel", "error", "-ss", String(at), "-i", input, "-frames:v", "1", output];
}

export interface ExtrasOptions {
  /** Poster time in OUTPUT seconds. */
  posterAt?: number;
  gifWidth?: number;
  gifFps?: number;
}

/** Make the extra files next to `video`; returns their paths. */
export async function exportExtras(video: string, kinds: ExtraFormat[], o: ExtrasOptions = {}): Promise<string[]> {
  const files: string[] = [];
  for (const kind of kinds) {
    const out = extraPath(video, kind);
    if (kind === "gif") await run("ffmpeg", buildGifArgs(video, out, { width: o.gifWidth ?? 800, fps: o.gifFps ?? 12 }));
    else if (kind === "webm") await run("ffmpeg", buildWebmArgs(video, out));
    else await run("ffmpeg", buildPosterArgs(video, out, posterTime((await probeVideo(video)).duration, o.posterAt)));
    files.push(out);
  }
  return files;
}
