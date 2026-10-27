import type { Hold, Segment } from "./schema.js";

// The edited video is a sequence of pieces cut from the source: "play" pieces
// (a source range at some speed) and "hold" pieces (one source frame frozen).
// Output times below are relative to the start of the edited video; Timeline
// adds `offset` (intro card length) when mapping.

export interface PlayPiece {
  kind: "play";
  in: number;
  out: number;
  speed: number;
  outStart: number;
  outEnd: number;
}

export interface HoldPiece {
  kind: "hold";
  at: number;
  dur: number;
  outStart: number;
  outEnd: number;
}

export type Piece = PlayPiece | HoldPiece;

export interface TimelineInput {
  segments: Segment[];
  holds: Hold[];
  sourceDuration: number;
  offset?: number;
}

const EPS = 1e-6;

export class Timeline {
  constructor(
    readonly pieces: Piece[],
    readonly offset: number,
    readonly ignoredHolds: Hold[],
  ) {}

  /** Length of the edited video, without intro/outro cards. */
  get videoDuration(): number {
    return this.pieces.at(-1)?.outEnd ?? 0;
  }

  /** Output time where the video ends (intro included). */
  get videoEnd(): number {
    return this.offset + this.videoDuration;
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

  /** Map a source span to output; the end falls back to start+dur when cut. */
  mapSpan(at: number, dur: number): { start: number; end: number } | null {
    const start = this.toOutput(at);
    if (start === null) return null;
    const mappedEnd = this.toOutput(at + dur);
    const end = mappedEnd !== null && mappedEnd > start ? mappedEnd : start + dur;
    return { start, end };
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

  const pushPlay = (from: number, to: number, speed: number) => {
    if (to - from < EPS) return;
    const len = (to - from) / speed;
    pieces.push({ kind: "play", in: from, out: to, speed, outStart: cursorOut, outEnd: cursorOut + len });
    cursorOut += len;
  };

  for (const seg of segs) {
    const inside = pending
      .filter((h) => !used.has(h.i) && h.at >= seg.in - EPS && h.at <= seg.out + EPS)
      .sort((a, b) => a.at - b.at);
    let cursor = seg.in;
    for (const h of inside) {
      used.add(h.i);
      pushPlay(cursor, h.at, seg.speed);
      pieces.push({ kind: "hold", at: h.at, dur: h.dur, outStart: cursorOut, outEnd: cursorOut + h.dur });
      cursorOut += h.dur;
      cursor = Math.max(cursor, h.at);
    }
    pushPlay(cursor, seg.out, seg.speed);
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
