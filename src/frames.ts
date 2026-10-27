import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./util/exec.js";

// Frames for the agent to look at. The optional grid labels normalized 0..1
// coordinates so zoom/highlight/callout positions can be read off the image.

function gridFilter(width: number): string {
  const parts = [`scale=${width}:-2`, "drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.35"];
  const box = "box=1:boxcolor=black@0.6:boxborderw=3:fontcolor=white:fontsize=14";
  for (let i = 1; i < 10; i++) {
    const v = (i / 10).toFixed(1);
    parts.push(`drawtext=text='${v}':x=w*${v}-12:y=4:${box}`);
    parts.push(`drawtext=text='${v}':x=4:y=h*${v}-8:${box}`);
  }
  return parts.join(",");
}

export interface FrameOptions {
  width?: number;
  grid?: boolean;
  outDir: string;
  prefix?: string;
}

export async function grabFrames(video: string, times: number[], opts: FrameOptions): Promise<{ t: number; file: string }[]> {
  await mkdir(opts.outDir, { recursive: true });
  const width = opts.width ?? 1280;
  const vf = opts.grid ? gridFilter(width) : `scale=${width}:-2`;
  const out: { t: number; file: string }[] = [];
  for (const t of times) {
    const file = join(opts.outDir, `${opts.prefix ?? "frame"}_${t.toFixed(2).replace(".", "_")}.jpg`);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", vf, "-pix_fmt", "yuvj420p", "-q:v", "3", file]);
    out.push({ t, file });
  }
  return out;
}

/** Evenly spaced times across a duration, avoiding the very first/last frame. */
export function evenTimes(duration: number, count: number): number[] {
  if (count <= 0 || duration <= 0) return [];
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => Math.round((step / 2 + i * step) * 100) / 100);
}
