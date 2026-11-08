import type { Timeline } from "../storyboard/timeline.js";
import type { RenderPlan } from "./plan.js";

// Long renders are split into chunks at quiet points: output times where nothing
// that moves or sounds is in progress, so a chunk rendered alone (windowPlan)
// looks and sounds like the same span of a one-piece render. A camera move,
// blend, freeze, card, voice line, overlay video or fade that straddles a point
// rejects it (the spike measured a visible jump for a camera move cut in half).

export interface Span {
  start: number;
  end: number;
}

export interface ChunkOptions {
  /** Preferred chunk length (s). Default 180. */
  target?: number;
  /** Shortest chunk (s). Default target / 3. */
  min?: number;
  /** More busy spans (output s), e.g. timelineBusy(): holds and transitions live in the cut, not in the plan. */
  busy?: Span[];
}

/** Seconds a click ripple shows (html.ts). */
const RIPPLE = 0.7;
/** Longest entrance or exit an overlay motion can have (MotionSchema.duration max). */
const MOTION_MAX = 3;
/** Spacing of candidate points inside one long quiet gap (s). */
const STEP = 10;
const EPS = 1e-6;

const round = (n: number) => Math.round(n * 1000) / 1000;

function merge(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end - s.start > EPS).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end + EPS) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Output spans in which the plan has something in progress, merged and sorted. */
export function busySpans(plan: RenderPlan): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => spans.push({ start, end });
  for (const a of plan.audio) {
    const end = a.start + a.duration;
    // Voice lines (and ready-made line files) are busy as a whole; beds (music, sfx) only where they fade or duck.
    if (a.src.startsWith("voice/")) add(a.start, end);
    if (a.fadeIn) add(a.start, a.start + a.fadeIn);
    if (a.fadeOut) add(end - a.fadeOut, end);
    for (const d of a.duck ?? []) add(d.t, d.t + d.dur);
  }
  for (const s of plan.subtitles) add(s.start, s.end);
  for (const c of plan.cards) add(c.start, c.start + c.dur);
  for (const c of plan.camera) add(c.t, c.t + c.dur);
  for (const o of plan.overlays) {
    if (o.kind === "video") add(o.start, o.end);
    else {
      // A still image looks the same either side of a cut; only its entrance and exit move.
      add(o.start, Math.min(o.end, o.start + MOTION_MAX));
      add(Math.max(o.start, o.end - MOTION_MAX), o.end);
    }
  }
  for (const list of [plan.texts, plan.highlights, plan.annotations, plan.keys]) for (const x of list) add(x.start, x.end);
  for (const r of plan.ripples) add(r.t, r.t + RIPPLE);
  return merge(spans).map((s) => ({ start: round(s.start), end: round(s.end) }));
}

/** Freezes (holds, chapter-card holds) and segment blends of the cut, in output seconds. */
export function timelineBusy(tl: Timeline): Span[] {
  const spans: Span[] = [];
  for (const p of tl.pieces) {
    if (p.kind === "hold") spans.push({ start: round(tl.offset + p.outStart), end: round(tl.offset + p.outEnd) });
    else if (p.transition) spans.push({ start: round(tl.offset + p.outStart), end: round(tl.offset + p.outStart + p.transition.dur) });
  }
  return merge(spans);
}

/**
 * Chunk boundaries in OUTPUT seconds: contiguous, covering [0, plan.duration),
 * every chunk at least `min` long. Cuts fall on whole seconds (exact in ms and on
 * every frame grid, draft fps included) where nothing is busy.
 *
 * Candidates are anchored to the content (the start and end of each quiet gap,
 * then every STEP seconds from its start), not to absolute times, so an edit that
 * shifts everything after it by whole seconds moves every later boundary by the
 * same amount: those chunks keep a chunk-relative slice that is identical, and so
 * their cache key (Review Focus 4).
 */
export function planChunks(plan: RenderPlan, opts: ChunkOptions = {}): Span[] {
  const target = opts.target ?? 180;
  const min = opts.min ?? target / 3;
  const duration = plan.duration;
  const busy = merge([...busySpans(plan), ...(opts.busy ?? [])]);

  const candidates = new Set<number>();
  let gapStart = 0;
  for (const gap of [...busy, { start: duration, end: duration }]) {
    const a = Math.ceil(gapStart - EPS);
    const b = Math.floor(gap.start + EPS);
    for (let p = a; p <= b; p += STEP) candidates.add(p);
    if (b >= a) candidates.add(b);
    gapStart = Math.max(gapStart, gap.end);
  }
  const points = [...candidates].filter((p) => p > 0 && p < duration - EPS).sort((x, y) => x - y);

  const chunks: Span[] = [];
  let cur = 0;
  // Stop when the rest fits in one chunk of about the target length.
  while (duration - cur > target * 1.5) {
    const ideal = cur + target;
    let best: number | undefined;
    for (const p of points) {
      if (p - cur < min - EPS || duration - p < min - EPS) continue;
      if (best === undefined || Math.abs(p - ideal) < Math.abs(best - ideal)) best = p;
    }
    if (best === undefined) break;
    chunks.push({ start: cur, end: best });
    cur = best;
  }
  chunks.push({ start: cur, end: duration });
  return chunks;
}
