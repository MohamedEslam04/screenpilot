import type { Hold, Segment } from "./schema.js";

type TransitionType = NonNullable<Segment["transition"]>["type"];

/** A piece that blends into the one before it: they overlap by `dur`. */
export interface PieceTransition {
  type: TransitionType;
  dur: number;
}

// The edited video is a sequence of pieces cut from the source: "play" pieces
// (a source range at some speed) and "hold" pieces (one source frame frozen).
// Output times below are relative to the start of the edited video; Timeline
// adds `offset` (intro card length) when mapping.

export interface PlayPiece {
  kind: "play";
  in: number;
  out: number;
  speed: number;
  /** Source audio gain for this piece (1 = untouched, 0 = silent). */
  volume: number;
  outStart: number;
  outEnd: number;
  /** How this piece enters over the end of the previous one (its `outStart` is already moved back by `dur`). */
  transition?: PieceTransition;
}

export interface HoldPiece {
  kind: "hold";
  at: number;
  dur: number;
  outStart: number;
  outEnd: number;
  /** Index into storyboard.cards when this freeze is a chapter card. */
  card?: number;
  /** How this freeze enters over the end of the previous piece. */
  transition?: PieceTransition;
}

export type Piece = PlayPiece | HoldPiece;

/** A hold; `card` marks the freeze that a chapter card is shown over. */
export type TimelineHold = Hold & { card?: number };

export interface TimelineInput {
  segments: Segment[];
  holds: TimelineHold[];
  sourceDuration: number;
  offset?: number;
}

const EPS = 1e-6;
/** A transition shorter than this (s) is not worth a blend. */
const MIN_TRANSITION = 0.05;

/** A speed ramp is played as steps of one speed each: about one per half second of source, at most this many. */
const RAMP_STEP = 0.5;
const RAMP_MAX_STEPS = 12;

/** Speed at source time `t` of a segment, ramping geometrically (so the change feels even) from `speed` to `speedTo`. */
export function speedAt(seg: Segment, t: number): number {
  if (seg.speedTo === undefined) return seg.speed;
  const k = Math.min(1, Math.max(0, (t - seg.in) / (seg.out - seg.in)));
  return seg.speed * (seg.speedTo / seg.speed) ** k;
}

/** The constant-speed steps a ramped segment is cut into; undefined for a segment at one speed. */
function rampSteps(seg: Segment): { in: number; out: number; speed: number }[] | undefined {
  if (seg.speedTo === undefined || Math.abs(seg.speedTo - seg.speed) < 1e-9) return undefined;
  const len = seg.out - seg.in;
  const n = Math.min(RAMP_MAX_STEPS, Math.max(2, Math.ceil(len / RAMP_STEP)));
  return Array.from({ length: n }, (_, i) => ({
    in: seg.in + (len * i) / n,
    out: i === n - 1 ? seg.out : seg.in + (len * (i + 1)) / n,
    speed: speedAt(seg, seg.in + (len * (i + 0.5)) / n),
  }));
}

export class Timeline {
  constructor(
    readonly pieces: Piece[],
    readonly offset: number,
    readonly ignoredHolds: TimelineHold[],
  ) {}

  /** Length of the edited video, without intro/outro cards. */
  get videoDuration(): number {
    return this.pieces.at(-1)?.outEnd ?? 0;
  }

  /** Output time where the video ends (intro included). */
  get videoEnd(): number {
    return this.offset + this.videoDuration;
  }

  /** Output spans of the chapter cards that made it into the timeline (intro offset included). */
  cardSpans(): { card: number; start: number; end: number }[] {
    const spans: { card: number; start: number; end: number }[] = [];
    for (const p of this.pieces) {
      if (p.kind === "hold" && p.card !== undefined) spans.push({ card: p.card, start: this.offset + p.outStart, end: this.offset + p.outEnd });
    }
    return spans;
  }

  /**
   * Output time at which source time `t` is shown. A user hold at exactly `t`
   * maps to the start of the freeze. Returns null when `t` was cut out.
   */
  toOutput(t: number): number | null {
    for (const p of this.pieces) {
      if (p.kind === "play" && t >= p.in - EPS && t < p.out - EPS) {
        return this.offset + p.outStart + Math.max(0, t - p.in) / p.speed;
      }
      if (p.kind === "hold" && Math.abs(p.at - t) < EPS) return this.offset + p.outStart;
    }
    for (const p of this.pieces) {
      if (p.kind === "play" && Math.abs(t - p.out) < EPS) return this.offset + p.outEnd;
    }
    return null;
  }

  /**
   * Like toOutput, but a cut-out time maps to where the next kept source
   * moment is shown. Null only when nothing after `t` is kept.
   */
  toOutputOrNext(t: number): number | null {
    const exact = this.toOutput(t);
    if (exact !== null) return exact;
    for (const p of this.pieces) {
      if (p.kind === "play" && p.in >= t - EPS) return this.offset + p.outStart;
    }
    return null;
  }

  /** Map a source span to output; the end falls back to start+dur when cut. */
  mapSpan(at: number, dur: number): { start: number; end: number } | null {
    const start = this.toOutput(at);
    if (start === null) return null;
    const mappedEnd = this.toOutput(at + dur);
    const end = mappedEnd !== null && mappedEnd > start ? mappedEnd : start + dur;
    return { start, end };
  }

  /**
   * Everything of source span [at, at+dur) that is shown, as output spans: each kept
   * piece clipped to the span and mapped with its own speed, a freeze whose frame lies
   * in the span included. Touching spans are joined, so a cut in the middle gives one
   * span unless something else is shown between the parts. Empty when all of it was cut.
   * Unlike mapSpan this does not need `at` to be kept and never stretches over a cut.
   */
  mapRanges(at: number, dur: number): { start: number; end: number }[] {
    const stop = at + dur;
    const found: { start: number; end: number }[] = [];
    for (const p of this.pieces) {
      if (p.kind === "hold") {
        if (p.at >= at - EPS && p.at < stop - EPS) found.push({ start: this.offset + p.outStart, end: this.offset + p.outEnd });
        continue;
      }
      const s = Math.max(at, p.in);
      const e = Math.min(stop, p.out);
      if (e - s <= EPS) continue;
      found.push({ start: this.offset + p.outStart + (s - p.in) / p.speed, end: this.offset + p.outStart + (e - p.in) / p.speed });
    }
    found.sort((a, b) => a.start - b.start);
    const out: { start: number; end: number }[] = [];
    for (const r of found) {
      const last = out.at(-1);
      if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
      else out.push({ ...r });
    }
    return out;
  }

  /** Index of the segment whose range contains source time t (inclusive end). */
  static segmentIndexOf(segments: Segment[], t: number): number {
    return segments.findIndex((s) => t >= s.in - EPS && t <= s.out + EPS);
  }
}

export function normalizeSegments(segments: Segment[], sourceDuration: number): Segment[] {
  const list = segments.length > 0 ? segments : [{ in: 0, out: sourceDuration, speed: 1 }];
  return list
    .map((s) => ({ ...s, out: Math.min(s.out, sourceDuration) }))
    .filter((s) => s.out > s.in + EPS);
}

export function buildTimeline({ segments, holds, sourceDuration, offset = 0 }: TimelineInput): Timeline {
  const segs = normalizeSegments(segments, sourceDuration);
  const pending = holds.map((h, i) => ({ ...h, i }));
  const used = new Set<number>();
  const pieces: Piece[] = [];
  let cursorOut = 0;
  let pendingTransition: Segment["transition"];

  /** The segment's transition, once, for the first piece it adds: clamped to half of either piece. */
  const enter = (len: number): { overlap: number; transition?: PieceTransition } => {
    const want = pendingTransition;
    pendingTransition = undefined;
    const prev = pieces.at(-1);
    if (!want || !prev) return { overlap: 0 };
    const dur = Math.round(Math.min(want.dur, (prev.outEnd - prev.outStart) / 2, len / 2) * 1000) / 1000;
    return dur >= MIN_TRANSITION ? { overlap: dur, transition: { type: want.type, dur } } : { overlap: 0 };
  };

  const pushPlay = (from: number, to: number, seg: Segment) => {
    const steps = rampSteps(seg);
    if (!steps) return pushStep(from, to, seg.speed, seg);
    // The steps belong to the whole segment, so a hold in the middle does not restart the ramp.
    for (const step of steps) pushStep(Math.max(from, step.in), Math.min(to, step.out), step.speed, seg);
  };

  const pushStep = (from: number, to: number, speed: number, seg: Segment) => {
    if (to - from < EPS) return;
    const len = (to - from) / speed;
    const { overlap, transition } = enter(len);
    cursorOut -= overlap;
    pieces.push({
      kind: "play",
      in: from,
      out: to,
      speed,
      volume: seg.mute ? 0 : (seg.volume ?? 1),
      outStart: cursorOut,
      outEnd: cursorOut + len,
      ...(transition ? { transition } : {}),
    });
    cursorOut += len;
  };

  for (const seg of segs) {
    pendingTransition = seg.transition;
    const inside = pending
      .filter((h) => !used.has(h.i) && h.at >= seg.in - EPS && h.at <= seg.out + EPS)
      .sort((a, b) => a.at - b.at);
    let cursor = seg.in;
    for (const h of inside) {
      used.add(h.i);
      pushPlay(cursor, h.at, seg);
      const { overlap, transition } = enter(h.dur);
      cursorOut -= overlap;
      pieces.push({
        kind: "hold",
        at: h.at,
        dur: h.dur,
        outStart: cursorOut,
        outEnd: cursorOut + h.dur,
        ...(h.card !== undefined ? { card: h.card } : {}),
        ...(transition ? { transition } : {}),
      });
      cursorOut += h.dur;
      cursor = Math.max(cursor, h.at);
    }
    pushPlay(cursor, seg.out, seg);
  }

  const ignored = pending.filter((h) => !used.has(h.i)).map(({ i: _i, ...h }) => h);
  return new Timeline(pieces, offset, ignored);
}

export interface TimedLine {
  at: number;
  duration: number;
}

/**
 * Narration lines are real audio with fixed lengths. When a line would still
 * be playing as the next one starts, freeze the video just before the next
 * line so the voice never overlaps and the picture waits for it. Returns the
 * extra holds to add (user holds are kept as they are).
 */
export function planNarrationHolds(
  input: TimelineInput & { lines: TimedLine[]; gap: number; tail?: number },
): Hold[] {
  const segs = normalizeSegments(input.segments, input.sourceDuration);
  const added: Hold[] = [];
  const lines = [...input.lines].sort((a, b) => a.at - b.at);
  const build = () => buildTimeline({ ...input, segments: segs, holds: [...input.holds, ...added] });
  let prevEnd: number | null = null;

  for (const line of lines) {
    const start = build().toOutput(line.at);
    if (start === null) continue;
    let actualStart = start;
    if (prevEnd !== null && start < prevEnd + input.gap - EPS) {
      const need = prevEnd + input.gap - start;
      const at = holdPointBefore(segs, line.at);
      if (at !== null) {
        added.push({ at, dur: need });
        actualStart = prevEnd + input.gap;
      }
    }
    prevEnd = actualStart + line.duration;
  }

  const tl = build();
  const last = segs.at(-1);
  if (prevEnd !== null && last && prevEnd > tl.videoEnd - EPS) {
    added.push({ at: last.out, dur: prevEnd - tl.videoEnd + (input.tail ?? 0.6) });
  }
  return added;
}

/** A source time just before `t` such that a hold there delays `t`. */
function holdPointBefore(segs: Segment[], t: number): number | null {
  const idx = Timeline.segmentIndexOf(segs, t);
  if (idx < 0) return null;
  const seg = segs[idx]!;
  const candidate = t - 0.001;
  if (candidate >= seg.in) return candidate;
  return idx > 0 ? segs[idx - 1]!.out : null;
}
