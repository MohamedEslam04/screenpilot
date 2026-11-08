import type { Rect } from "../record/input/types.js";

// Pure helpers for Desktop.workArea: the usable part of a monitor (no panel,
// taskbar or dock). Kept free of OS calls so they are unit tested anywhere.

/** The overlap of two rects; undefined when they are disjoint or only touch. */
export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

/** Whether a reported work area can be trusted: not empty and inside its monitor (1 px of rounding allowed). */
export function sane(area: Rect, monitor: Rect): boolean {
  const nums = [area.x, area.y, area.w, area.h];
  if (!nums.every(Number.isFinite) || area.w <= 0 || area.h <= 0) return false;
  const tol = 1;
  return (
    area.x >= monitor.x - tol &&
    area.y >= monitor.y - tol &&
    area.x + area.w <= monitor.x + monitor.w + tol &&
    area.y + area.h <= monitor.y + monitor.h + tol
  );
}
