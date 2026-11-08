import { createHash } from "node:crypto";
import type { Piece, Timeline } from "../storyboard/timeline.js";
import { renderHtml } from "./html.js";
import type { RenderPlan } from "./plan.js";
import { windowPlan } from "./window.js";

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
 * Candidates are anchored to the content (the end of each quiet gap, then every
 * STEP seconds back from it), not to absolute times, so an edit that shifts
 * everything after it by whole seconds moves every later boundary by the same
 * amount: those chunks keep a chunk-relative slice that is identical, and so
 * their cache key (Review Focus 4). A shift by a fraction of a second (most
 * narration-length changes) moves the content between frames, so later chunks
 * render again.
 */
export function planChunks(plan: RenderPlan, opts: ChunkOptions = {}): Span[] {
  const target = opts.target ?? 180;
  const min = opts.min ?? target / 3;
  const duration = plan.duration;
  const busy = merge([...busySpans(plan), ...(opts.busy ?? [])]);

  const candidates = new Set<number>();
  let gapStart = 0;
  for (const next of [...busy, { start: duration, end: duration }]) {
    // Counted back from the end of the gap: an edit before it (in the same gap or earlier) moves the end, so these move with it.
    const a = Math.ceil(gapStart - EPS);
    for (let p = Math.floor(next.start + EPS); p >= a; p -= STEP) candidates.add(p);
    gapStart = Math.max(gapStart, next.end);
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

/** What the build-dir files a plan names really contain, for chunkKey (filled by prepareBuild). */
export interface ChunkSources {
  /** Build-dir path -> identity of its content (the original file's size and time, or a cache key). Paths not listed key by name. */
  files: Record<string, string>;
  /** The cut recording: described by the pieces a chunk shows, so a recut that only shifts them keeps the key. */
  video: { src: string; cut: string; pieces: Piece[] };
  /** The mixed sound effects track: described by the hits a chunk hears. */
  sfx?: { src: string; hits: { at: number; volume: number; sound: string }[] };
}

/** A sound effect that starts this long before a chunk can still be heard in it (built-in sounds last under 1 s). */
const SFX_TAIL = 10;

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** The pieces of the cut shown in [from, to) of edited.mp4, clipped to it and made relative to `from`. */
function shownPieces(pieces: Piece[], from: number, to: number): unknown[] {
  const out: unknown[] = [];
  for (const p of pieces) {
    const s = Math.max(p.outStart, from);
    const e = Math.min(p.outEnd, to);
    if (e - s <= EPS) continue;
    const span = { outStart: round(s - from), outEnd: round(e - from) };
    // A blend shows the end of the piece before it, which is then in range too; one that ended before `from` is not seen.
    const transition = p.transition && s === p.outStart ? { transition: p.transition } : {};
    if (p.kind === "hold") out.push({ kind: "hold", at: p.at, ...span, ...transition });
    else out.push({ kind: "play", in: round(p.in + (s - p.outStart) * p.speed), out: round(p.in + (e - p.outStart) * p.speed), speed: p.speed, volume: p.volume, ...span, ...transition });
  }
  return out;
}

/**
 * Cache key of one chunk: its window of the plan with every time chunk-relative
 * (windowPlan), each file replaced by what it contains, the cut recording by the
 * source pieces the chunk shows and the sound effects track by the hits it hears.
 * Nothing absolute is left except offsets into files whose content really differs
 * there (the music), so an edit elsewhere never changes the key of a chunk whose own
 * slice is identical, even when the edit shifted it (Review Focus 3 and 4).
 * `render` carries the render settings (quality, frame format, HyperFrames version).
 * The composition HTML is hashed too, so a change in the HTML generator re-renders.
 */
export function chunkKey(full: RenderPlan, chunk: Span, sources: ChunkSources, render: string): string {
  const slice = windowPlan(full, { from: chunk.start, to: chunk.end });
  const { mediaStart: videoFrom = 0, ...video } = slice.video;
  const id = (src: string) => sources.files[src] ?? src;
  const sfx = sources.sfx;
  const norm: RenderPlan = {
    ...slice,
    video: {
      ...video,
      src: sha1(JSON.stringify([sources.video.cut, shownPieces(sources.video.pieces, videoFrom, videoFrom + video.duration)])),
    },
    audio: slice.audio.map((a) => {
      if (!sfx || a.src !== sfx.src) return { ...a, src: id(a.src) };
      const { mediaStart: from = 0, ...rest } = a;
      const heard = sfx.hits.filter((h) => h.at >= from - SFX_TAIL && h.at < from + a.duration).map((h) => ({ ...h, at: round(h.at - from) }));
      return { ...rest, src: sha1(JSON.stringify(heard)) };
    }),
    overlays: slice.overlays.map((o) => ({ ...o, src: id(o.src) })),
  };
  return sha1(`${render}\n${JSON.stringify(norm)}\n${renderHtml(norm, { gsapSrc: "gsap.min.js" })}`);
}
