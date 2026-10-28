import type { Storyboard } from "./schema.js";
import type { Timeline } from "./timeline.js";

// Style checks from the AGENTS.md rules. Pure, and warnings only: they help an
// agent notice a storyboard that will look or sound off, never block a render.
// Every message names the item index so it can be fixed straight away.

const MAX_NARRATION_WORDS = 12;
const MAX_CAPTION_WORDS = 6;
/** Natural speech is about 2.5 words/s; faster than this the voice sounds rushed. */
const MAX_WORDS_PER_SECOND = 3;
const ZOOM_SCALE = { min: 1.4, max: 2.5 };
const MAX_SPEED = 8;
const STACK_WINDOW = 1; // s
const STACK_RADIUS = 0.15; // normalized distance counted as "the same point"
const DURATION = { min: 15, max: 90 }; // s, output

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const fix = (n: number) => n.toFixed(1);

interface Span {
  i: number;
  start: number;
  end: number;
}

/** Index pairs (later, earlier) of spans that overlap in time, spans being half-open. */
function overlaps<T extends Span>(spans: T[]): [T, T][] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.i - b.i);
  const pairs: [T, T][] = [];
  sorted.forEach((b, k) => {
    for (const a of sorted.slice(0, k)) if (a.end > b.start) pairs.push([b, a]);
  });
  return pairs;
}

export function lintStyle(sb: Storyboard): string[] {
  const out: string[] = [];

  // Narration: length, and speed relative to the room before the next line.
  const lines = sb.narration.map((n, i) => ({ n, i, words: countWords(n.text) })).sort((a, b) => a.n.at - b.n.at);
  lines.forEach(({ n, i, words }, k) => {
    if (words > MAX_NARRATION_WORDS) out.push(`narration[${i}] has ${words} words (over ${MAX_NARRATION_WORDS}); shorten it to one idea`);
    const next = lines[k + 1];
    if (!next) return;
    const gap = next.n.at - n.at;
    if (gap > 0 && words / gap > MAX_WORDS_PER_SECOND) {
      out.push(
        `narration[${i}]: ${words} words in the ${fix(gap)}s before narration[${next.i}] is too fast to speak; render will freeze the video to fit, so the pacing drags`,
      );
    }
  });

  // Captions: length, and two in the same spot at the same time. Callouts
  // point at their own x/y, so they are left out of the overlap check.
  sb.captions.forEach((c, i) => {
    const words = countWords(c.text);
    if (words > MAX_CAPTION_WORDS) out.push(`captions[${i}] has ${words} words (over ${MAX_CAPTION_WORDS}); keep captions to 2-6 words`);
  });
  const captionSpans = sb.captions.map((c, i) => ({ i, start: c.at, end: c.at + c.dur, c }));
  for (const [b, a] of overlaps(captionSpans.filter((s) => s.c.style !== "callout"))) {
    const pos = b.c.style === "title" ? "center" : b.c.position;
    const posA = a.c.style === "title" ? "center" : a.c.position;
    if (pos === posA) out.push(`captions[${b.i}] overlaps captions[${a.i}] in time at the same position (${pos})`);
  }

  // Zooms: scale, and overlap.
  sb.zooms.forEach((z, i) => {
    if (z.scale < ZOOM_SCALE.min || z.scale > ZOOM_SCALE.max) {
      out.push(`zooms[${i}] has scale ${z.scale} (outside ${ZOOM_SCALE.min}-${ZOOM_SCALE.max}); use roughly 1.6-2.2`);
    }
  });
  for (const [b, a] of overlaps(sb.zooms.map((z, i) => ({ i, start: z.at, end: z.at + z.dur })))) {
    out.push(`zooms[${b.i}] overlaps zooms[${a.i}] in time`);
  }

  // Zoom + highlight + callout on one point at once is too much.
  sb.zooms.forEach((z, zi) => {
    sb.highlights.forEach((h, hi) => {
      const hc = { x: h.x + h.w / 2, y: h.y + h.h / 2 };
      if (!near(z.at, z, h.at, hc)) return;
      sb.captions.forEach((c, ci) => {
        if (c.style !== "callout") return;
        const cp = { x: c.x ?? 0.5, y: c.y ?? 0.5 };
        if (!near(z.at, z, c.at, cp) || !near(h.at, hc, c.at, cp)) return;
        out.push(`zooms[${zi}], highlights[${hi}] and captions[${ci}] (callout) stack on the same point within ${STACK_WINDOW}s; pick one or two`);
      });
    });
  });

  sb.segments.forEach((s, i) => {
    if (s.speed > MAX_SPEED) out.push(`segments[${i}] runs at ${s.speed}x (over ${MAX_SPEED}x); it will look like a glitch, cut it instead`);
  });

  return out;
}

function near(ta: number, a: { x: number; y: number }, tb: number, b: { x: number; y: number }): boolean {
  return Math.abs(ta - tb) <= STACK_WINDOW && Math.hypot(a.x - b.x, a.y - b.y) <= STACK_RADIUS;
}

/** Checks that need the built timeline (narration freezes included). */
export function lintTimeline(sb: Storyboard, timeline: Timeline): string[] {
  const total = timeline.videoEnd + (sb.outro?.dur ?? 0);
  if (total > DURATION.max) return [`the video is ${fix(total)}s long (over ${DURATION.max}s); cut idle time or speed up segments`];
  if (total < DURATION.min) return [`the video is only ${fix(total)}s long (under ${DURATION.min}s); add pacing or a longer take`];
  return [];
}
