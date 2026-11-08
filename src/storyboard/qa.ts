import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { run } from "../util/exec.js";
import { loadStoryboard } from "./load.js";

// Checks that need the pixels, run on the raw recording: highlights that frame
// a flat area (the element is gone or hidden) and views that show the desktop
// next to the app. Warnings only, like lint; slower, so a separate command.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FLAT_RANGE = 12; // YHIGH - YLOW below this: nothing is drawn there
const MAX_OUTSIDE = 0.08; // share of a view that may lie outside the active window

export function isFlat(stats: { ylow: number; yhigh: number }): boolean {
  return stats.yhigh - stats.ylow < FLAT_RANGE;
}

/** Share (0..1) of the view's area that lies outside the window. */
export function outsideFraction(view: Rect, win: Rect): number {
  const iw = Math.min(view.x + view.w, win.x + win.w) - Math.max(view.x, win.x);
  const ih = Math.min(view.y + view.h, win.y + win.h) - Math.max(view.y, win.y);
  const inside = Math.max(0, iw) * Math.max(0, ih);
  return Math.min(1, Math.max(0, 1 - inside / (view.w * view.h)));
}

interface WindowSpan extends Rect {
  t: number;
}

async function readWindows(path: string): Promise<WindowSpan[]> {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l) as WindowSpan).sort((a, b) => a.t - b.t);
}

async function cropStats(video: string, t: number, r: Rect): Promise<{ ylow: number; yhigh: number } | undefined> {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const crop = `crop=w=max(2\\,iw*${c(r.w)}):h=max(2\\,ih*${c(r.h)}):x=iw*${c(r.x)}:y=ih*${c(r.y)}`;
  const { stdout } = await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    t.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    `${crop},signalstats,metadata=print:file=-`,
    "-f",
    "null",
    "-",
  ]);
  const low = /lavfi\.signalstats\.YLOW=([\d.]+)/.exec(stdout);
  const high = /lavfi\.signalstats\.YHIGH=([\d.]+)/.exec(stdout);
  return low && high ? { ylow: Number(low[1]), yhigh: Number(high[1]) } : undefined;
}

export async function qaStoryboard(path: string): Promise<string[]> {
  const { sb, baseDir } = await loadStoryboard(path);
  const source = resolve(baseDir, sb.source);
  if (!existsSync(source)) return [`source not found: ${source}`];
  const warnings: string[] = [];

  for (const [i, h] of sb.highlights.entries()) {
    const stats = await cropStats(source, h.at + Math.min(h.dur / 2, 1), h);
    if (stats && isFlat(stats)) warnings.push(`[empty-highlight] highlights[${i}] at ${h.at}s frames a flat area`);
  }

  // windows.jsonl sits next to the raw recording (the session dir), times in source seconds.
  const windows = await readWindows(join(dirname(source), "windows.jsonl"));
  for (const [i, v] of sb.views.entries()) {
    if (!v.rect) continue;
    const win = windows.filter((w) => w.t <= v.at).at(-1);
    if (!win) continue;
    const out = outsideFraction(v.rect, win);
    if (out > MAX_OUTSIDE) warnings.push(`[view-outside-window] views[${i}] (${v.at}s) shows ${Math.round(out * 100)}% outside the active window`);
  }
  return warnings;
}
