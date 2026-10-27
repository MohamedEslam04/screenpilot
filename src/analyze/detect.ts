// Pure heuristics over a recording's freeze spans and pointer events.

export interface Span {
  start: number;
  end: number;
}

export interface Point {
  t: number;
  x: number;
  y: number;
}

/** Parse `freezedetect` output (ffmpeg -loglevel info) into frozen spans. */
export function parseFreezes(stderr: string, duration: number): Span[] {
  const spans: Span[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /freeze_start: ([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /freeze_end: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      spans.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) spans.push({ start, end: duration });
  return spans;
}

/** Frozen spans long enough to matter and without clicks inside. */
export function idleSpans(freezes: Span[], clicks: Point[], minLen = 2.5): Span[] {
  return freezes
    .filter((f) => f.end - f.start >= minLen)
    .filter((f) => !clicks.some((c) => c.t > f.start + 0.2 && c.t < f.end - 0.2))
    .map((f) => ({ start: round(f.start), end: round(f.end) }));
}

/**
 * Drop the middle of idle spans (a short margin stays on both sides). When
 * that would leave almost nothing, e.g. a mostly static recording, the idle
 * middles are fast-forwarded instead of cut.
 */
export function suggestSegments(
  duration: number,
  idle: Span[],
  margin = 0.6,
  fastSpeed = 4,
): { in: number; out: number; speed: number }[] {
  const middles = [...idle]
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ from: s.start + margin, to: s.end - margin }))
    .filter((m) => m.to - m.from >= 1);
  const cutTotal = middles.reduce((sum, m) => sum + (m.to - m.from), 0);
  const keepAll = duration - cutTotal < Math.max(3, duration * 0.3);

  const segs: { in: number; out: number; speed: number }[] = [];
  let cursor = 0;
  for (const m of middles) {
    if (m.from > cursor) segs.push({ in: round(cursor), out: round(m.from), speed: 1 });
    if (keepAll) segs.push({ in: round(m.from), out: round(m.to), speed: fastSpeed });
    cursor = m.to;
  }
  if (duration > cursor) segs.push({ in: round(cursor), out: round(duration), speed: 1 });
  return segs.filter((s) => s.out - s.in > 0.05);
}

/**
 * Where the pointer came to rest after travelling: a stand-in for clicks
 * when buttons were not recorded.
 */
export function dwellPoints(moves: Point[], minRest = 0.5, minTravel = 0.05): Point[] {
  const out: Point[] = [];
  let anchor = moves[0];
  for (let i = 1; i < moves.length; i++) {
    const prev = moves[i - 1]!;
    const cur = moves[i]!;
    if (cur.t - prev.t >= minRest && anchor && dist(anchor, prev) >= minTravel) {
      out.push({ t: round(prev.t), x: prev.x, y: prev.y });
      anchor = prev;
    }
    if (!anchor) anchor = cur;
  }
  return out;
}

/** Group nearby clicks into zooms: one zoom per burst of activity in one area. */
export function suggestZooms(
  clicks: Point[],
  opts: { gap?: number; radius?: number; scale?: number; lead?: number; tail?: number } = {},
): { at: number; dur: number; x: number; y: number; scale: number }[] {
  const gap = opts.gap ?? 3;
  const radius = opts.radius ?? 0.18;
  const lead = opts.lead ?? 0.4;
  const tail = opts.tail ?? 1.6;
  const groups: Point[][] = [];
  for (const c of [...clicks].sort((a, b) => a.t - b.t)) {
    const g = groups.at(-1);
    const last = g?.at(-1);
    if (g && last && c.t - last.t <= gap && dist(centroid(g), c) <= radius) g.push(c);
    else groups.push([c]);
  }
  return groups.map((g) => {
    const c = centroid(g);
    const at = Math.max(0, g[0]!.t - lead);
    return { at: round(at), dur: round(g.at(-1)!.t - at + tail), x: round(c.x, 3), y: round(c.y, 3), scale: opts.scale ?? 1.8 };
  });
}

export interface ScreenRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen under a point, or the nearest one when it sits in a gap. */
function screenAt(screens: ScreenRect[], p: { x: number; y: number }): ScreenRect | undefined {
  let best: ScreenRect | undefined;
  let bestD = Infinity;
  for (const s of screens) {
    const dx = Math.max(s.x - p.x, 0, p.x - (s.x + s.w));
    const dy = Math.max(s.y - p.y, 0, p.y - (s.y + s.h));
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * Camera views from pointer evidence (moves and clicks, normalized to the
 * full video): switch to another monitor once the pointer has stayed on it
 * for `minDwell` seconds. The first view (t=0) is where the pointer starts.
 */
export function suggestViews(
  moves: Point[],
  screens: ScreenRect[],
  opts: { minDwell?: number } = {},
): { at: number; screen: string; transition: "pan" | "cut" }[] {
  if (screens.length === 0) return [];
  const minDwell = opts.minDwell ?? 1;
  const pts = [...moves].sort((a, b) => a.t - b.t).map((p) => ({ t: p.t, name: screenAt(screens, p)!.name }));
  let cur = pts[0]?.name ?? screens[0]!.name;
  const views: { at: number; screen: string; transition: "pan" | "cut" }[] = [{ at: 0, screen: cur, transition: "pan" }];
  for (let i = 0; i < pts.length; ) {
    let j = i;
    while (j + 1 < pts.length && pts[j + 1]!.name === pts[i]!.name) j++;
    const end = pts[j + 1]?.t ?? pts[j]!.t;
    if (pts[i]!.name !== cur && end - pts[i]!.t >= minDwell) {
      cur = pts[i]!.name;
      views.push({ at: round(pts[i]!.t), screen: cur, transition: "pan" });
    }
    i = j + 1;
  }
  return views;
}

function centroid(g: Point[]): { x: number; y: number } {
  return { x: g.reduce((s, p) => s + p.x, 0) / g.length, y: g.reduce((s, p) => s + p.y, 0) / g.length };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
