import type { Storyboard } from "./schema.js";
import { normalizeSegments } from "./timeline.js";

// A slice of a storyboard: only source range [from, to] of it. Rules:
// - Ranges are half-open, [from, to): something at exactly `to` belongs to the
//   slice that starts there, except at the very end of the video, so the
//   slices [0, 42) and [42, end] together keep every item once.
// - holds, narration and views are kept when their `at` is in the range.
//   Narration that started before `from` is dropped (a line can't resume mid-word).
// - zooms, captions and highlights are cut to the range: one that started
//   before `from` and still runs then is re-timed to start at `from`, one that
//   runs past `to` ends there. If less than MIN_SPAN of it is left, it is dropped.
// - The camera starts where it was: the last view before `from` moves to `from`.
// - Click ripples need nothing: the timeline drops clicks outside the segments.

const EPS = 1e-6;
/** Shortest piece of a zoom/caption/highlight worth keeping after a cut (s). */
export const MIN_SPAN = 0.5;

export function clipStoryboard(sb: Storyboard, range: { from?: number; to?: number }, sourceDuration: number): Storyboard {
  const from = range.from ?? 0;
  const to = range.to ?? sourceDuration;
  if (to <= from) throw new Error(`range from ${from}s to ${to}s keeps nothing (from must be before to and the end of the source)`);

  const all = normalizeSegments(sb.segments, sourceDuration);
  const end = all.at(-1)?.out ?? sourceDuration;
  const segments = all
    .map((s) => ({ ...s, in: Math.max(s.in, from), out: Math.min(s.out, to) }))
    .filter((s) => s.out > s.in + EPS);
  if (segments.length === 0) throw new Error(`range from ${from}s to ${to}s keeps nothing of the storyboard's segments`);

  const toEnd = to >= end - EPS;
  const inRange = (t: number) => t >= from - EPS && (t < to - EPS || (toEnd && t <= to + EPS));
  const clipSpan = <T extends { at: number; dur: number }>(items: T[]): T[] =>
    items.flatMap((item) => {
      const start = Math.max(item.at, from);
      if (!inRange(start)) return [];
      const stop = toEnd ? item.at + item.dur : Math.min(item.at + item.dur, to);
      return stop - start >= MIN_SPAN - EPS ? [{ ...item, at: start, dur: round(stop - start) }] : [];
    });

  const views = [...sb.views].sort((a, b) => a.at - b.at);
  const kept = views.filter((v) => inRange(v.at));
  const before = views.filter((v) => v.at < from - EPS).at(-1);
  if (before && !kept.some((v) => Math.abs(v.at - from) < EPS)) kept.unshift({ ...before, at: from });

  return {
    ...sb,
    segments,
    holds: sb.holds.filter((h) => inRange(h.at)),
    zooms: clipSpan(sb.zooms),
    captions: clipSpan(sb.captions),
    highlights: clipSpan(sb.highlights),
    narration: sb.narration.filter((n) => inRange(n.at)),
    views: kept,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
