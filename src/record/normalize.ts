import type { InputEvent } from "./events.js";
import type { RawEvent, Rect } from "./input/types.js";

/**
 * Raw desktop-pixel events → events.jsonl entries: seconds since the
 * recording started and coordinates normalized to the recorded VIDEO (the
 * captured screen may be letterboxed inside the OBS canvas: `content`).
 * Events before the start or off the recorded screen are dropped.
 */
export function normalizeEvents(raw: RawEvent[], startedAt: number, screen: Rect, content: Rect): InputEvent[] {
  const out: InputEvent[] = [];
  for (const e of raw) {
    const t = (e.at - startedAt) / 1000;
    if (t < 0) continue;
    const sx = (e.px - screen.x) / screen.w;
    const sy = (e.py - screen.y) / screen.h;
    if (sx < 0 || sx > 1 || sy < 0 || sy > 1) continue;
    const ev: InputEvent = {
      t: round(t, 3),
      type: e.type,
      x: round(content.x + sx * content.w, 4),
      y: round(content.y + sy * content.h, 4),
    };
    if (e.button !== undefined) ev.button = e.button;
    out.push(ev);
  }
  return out;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export interface WindowSpan {
  t: number;
  id: string;
  cls: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Active-window reports → recording coordinates, clipped to what was recorded. */
export function normalizeWindows(
  raw: { at: number; id: string; cls: string; title: string; x: number; y: number; w: number; h: number }[],
  startedAt: number,
  screen: Rect,
  content: Rect,
): WindowSpan[] {
  const out: WindowSpan[] = [];
  const nx = (px: number) => content.x + ((px - screen.x) / screen.w) * content.w;
  const ny = (py: number) => content.y + ((py - screen.y) / screen.h) * content.h;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  for (const w of raw) {
    const x0 = clip(nx(w.x));
    const y0 = clip(ny(w.y));
    const x1 = clip(nx(w.x + w.w));
    const y1 = clip(ny(w.y + w.h));
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) continue; // not on the recorded area
    out.push({
      t: round(Math.max(0, (w.at - startedAt) / 1000), 3),
      id: w.id,
      cls: w.cls,
      title: w.title,
      x: round(x0, 4),
      y: round(y0, 4),
      w: round(x1 - x0, 4),
      h: round(y1 - y0, 4),
    });
  }
  return out;
}
