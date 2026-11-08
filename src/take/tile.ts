import type { Desktop } from "../platform/types.js";
import { sane } from "../platform/work-area.js";
import type { Rect, ScreenInfo } from "../record/input/types.js";
import { globalRectToRecording } from "./track.js";

/**
 * Where tiles go on `screen`: its work area (no panel, taskbar or dock) when the desktop reports a
 * sane one, else the whole monitor (global px). Never throws: a failed query falls back with a warning.
 */
export async function tileTarget(desktop: Pick<Desktop, "workArea">, screen: ScreenInfo, warn: (m: string) => void): Promise<Rect> {
  const monitor = { x: screen.x, y: screen.y, w: screen.w, h: screen.h };
  try {
    const area = await desktop.workArea?.(screen.name);
    if (!area) return monitor;
    if (sane(area, monitor)) return area;
    warn(`tile: ignoring the work area reported for ${screen.name} (${rectText(area)}, monitor ${rectText(monitor)}); using the whole monitor`);
  } catch (e) {
    warn(`tile: no work area for ${screen.name} (${(e as Error).message}); using the whole monitor`);
  }
  return monitor;
}

const rectText = (r: Rect) => `${r.x},${r.y} ${r.w}x${r.h}`;

/**
 * `n` windows side by side in `area` (global px, see tileTarget): equal widths, the area's full height, left to right in list
 * order. Edges are rounded so the columns cover the area exactly, with no gap or overlap.
 */
export function tileRects(area: Rect, n: number): Rect[] {
  const edge = (i: number) => area.x + Math.round((i * area.w) / n);
  return Array.from({ length: n }, (_, i) => ({ x: edge(i), y: area.y, w: edge(i + 1) - edge(i), h: area.h }));
}

/** The smallest rect around every rect (global px). */
export function boundingRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x1 - x, h: y1 - y };
}

/**
 * The one camera view of a take that used several demo browsers: their tiled area (global px)
 * in recording coordinates (`meta.screen`, `meta.capture.contentRect`), held from the start.
 */
export function tiledView(
  area: Rect,
  screen: Rect,
  content: Rect,
  browsers: string[],
): { at: number; rect: Rect; label: string; transition: "cut" } {
  return { at: 0, rect: globalRectToRecording(area, screen, content, 0), label: `browsers: ${browsers.join(", ")}`, transition: "cut" };
}
