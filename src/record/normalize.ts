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
