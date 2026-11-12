import type { LINT_RULES, Storyboard } from "./schema.js";
import { normalizeSegments, type Timeline } from "./timeline.js";

// Style checks from the AGENTS.md rules. Pure, and warnings only: they help an
// agent notice a storyboard that will look or sound off, never block a render.
// Every message names the item index so it can be fixed straight away.

const MAX_NARRATION_WORDS = 12;
const MAX_CAPTION_WORDS = 6;
/** Natural speech is about 2.5 words/s; faster than this the voice sounds rushed. */
const MAX_WORDS_PER_SECOND = 3;
const ZOOM_SCALE = { min: 1.4, max: 2.5 };
const MAX_SPEED = 8;
const MAX_TRANSITION = 2; // s
const MIN_RAMP = 1; // s of source a speed ramp needs to read as one
const STACK_WINDOW = 1; // s
const STACK_RADIUS = 0.15; // normalized distance counted as "the same point"
const MIN_BLUR_AREA = 0.0005; // fraction of the recording
const MIN_ARROW = 0.01; // normalized length
const DURATION = { min: 15, max: 90 }; // s, output

type Rule = (typeof LINT_RULES)[number];

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
  const maxNarration = sb.lint?.narrationWords ?? MAX_NARRATION_WORDS;
  const maxCaption = sb.lint?.captionWords ?? MAX_CAPTION_WORDS;
  const off = new Set<Rule>(sb.lint?.off);
  /** Add a warning under its rule id unless that rule is turned off. */
  const warn = (rule: Rule, msg: string) => {
    if (!off.has(rule)) out.push(`[${rule}] ${msg}`);
  };

  // Narration: length, and speed relative to the room before the next line.
  const lines = sb.narration.map((n, i) => ({ n, i, words: countWords(n.text) })).sort((a, b) => a.n.at - b.n.at);
  lines.forEach(({ n, i, words }, k) => {
    if (words > maxNarration) warn("narration-length", `narration[${i}] has ${words} words (over ${maxNarration}); shorten it to one idea`);
    const next = lines[k + 1];
    if (!next) return;
    const gap = next.n.at - n.at;
    if (gap > 0 && words / gap > MAX_WORDS_PER_SECOND) {
      warn(
        "narration-speed",
        `narration[${i}]: ${words} words in the ${fix(gap)}s before narration[${next.i}] is too fast to speak; render will freeze the video to fit, so the pacing drags`,
      );
    }
  });

  // Captions: length, and two in the same spot at the same time. Callouts
  // point at their own x/y, so they are left out of the overlap check.
  sb.captions.forEach((c, i) => {
    const words = countWords(c.text);
    if (words > maxCaption) warn("caption-length", `captions[${i}] has ${words} words (over ${maxCaption}); keep captions to 2-6 words`);
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
      warn("zoom-scale", `zooms[${i}] has scale ${z.scale} (outside ${ZOOM_SCALE.min}-${ZOOM_SCALE.max}); use roughly 1.6-2.2`);
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
        warn("stack", `zooms[${zi}], highlights[${hi}] and captions[${ci}] (callout) stack on the same point within ${STACK_WINDOW}s; pick one or two`);
      });
    });
  });

  // Annotations and key-caps.
  sb.annotations.forEach((a, i) => {
    if (a.type === "blur" && a.w * a.h < MIN_BLUR_AREA) {
      out.push(`annotations[${i}] blur covers a very small area (${(a.w * 100).toFixed(1)}% x ${(a.h * 100).toFixed(1)}% of the recording); check it covers all of what you want hidden`);
    }
    if (a.type === "arrow" && Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) < MIN_ARROW) {
      out.push(`annotations[${i}] arrow has no length (from and to are the same point) and will not be drawn`);
    }
  });
  if (sb.sounds?.typing && sb.typing.length === 0) out.push("sounds.typing is on but there are no typing spans; add typing: [{ at, dur, text }] where the recording shows typing");
  sb.typing.forEach((t, i) => {
    if (!t.keycaps && !sb.sounds?.typing) out.push(`typing[${i}] does nothing: turn on sounds.typing for a typing sound or keycaps (with text) to show the typed words`);
    if (t.keycaps && !t.text?.trim()) out.push(`typing[${i}] has keycaps but no text; set text to the words that are typed`);
  });

  sb.segments.forEach((s, i) => {
    const top = Math.max(s.speed, s.speedTo ?? 0);
    if (top > MAX_SPEED) out.push(`segments[${i}] runs at ${+top.toFixed(2)}x (over ${MAX_SPEED}x); it will look like a glitch, cut it instead`);
    if (s.transition && i === 0) warn("transition", `segments[0] has a transition but is the first segment, so there is nothing before it to blend with`);
    if (s.transition && s.transition.dur > MAX_TRANSITION) {
      warn("transition", `segments[${i}] transition is long (${fix(s.transition.dur)}s, over ${MAX_TRANSITION}s); it also makes the video that much shorter, use 0.3-1s`);
    }
    if (s.speedTo !== undefined && s.speedTo !== s.speed && s.out - s.in < MIN_RAMP) {
      out.push(`segments[${i}] has a speed ramp but is only ${fix(s.out - s.in)}s long (too short to see it); use a segment of ${MIN_RAMP}s or more`);
    }
  });

  return out;
}

function near(ta: number, a: { x: number; y: number }, tb: number, b: { x: number; y: number }): boolean {
  return Math.abs(ta - tb) <= STACK_WINDOW && Math.hypot(a.x - b.x, a.y - b.y) <= STACK_RADIUS;
}

/**
 * Annotations whose source range [at, at+dur) is not wholly in kept footage: completely cut (never drawn) or partly cut
 * (drawn only over the kept part). Never silent, because a blur that hides a secret is the reason to look. Needs the
 * source length to know where the last segment ends.
 */
export function lintAnnotationRanges(sb: Storyboard, sourceDuration: number): string[] {
  const off = sb.lint?.off?.includes("annotation-outside");
  if (off) return [];
  const kept: { in: number; out: number }[] = [];
  for (const s of normalizeSegments(sb.segments, sourceDuration).sort((a, b) => a.in - b.in)) {
    const last = kept.at(-1);
    if (last && s.in <= last.out) last.out = Math.max(last.out, s.out);
    else kept.push({ in: s.in, out: s.out });
  }
  const out: string[] = [];
  sb.annotations.forEach((a, i) => {
    const end = a.at + a.dur;
    const shown = kept.map((k) => ({ in: Math.max(k.in, a.at), out: Math.min(k.out, end) })).filter((r) => r.out - r.in > 0.05);
    const covered = shown.reduce((sum, r) => sum + (r.out - r.in), 0);
    const name = a.type === "blur" && a.mode === "solid" ? "solid blur" : a.type;
    const range = `${fix(a.at)}s-${fix(end)}s`;
    if (shown.length === 0) {
      const effect = a.type === "blur" && a.mode === "solid" ? `ERROR: annotations[${i}] is a ${name} (${range}) completely in cut footage, so it is never drawn; if it hides a secret, move it onto footage that is kept` : `annotations[${i}] ${name} (${range}) is completely in cut footage and will not be drawn`;
      out.push(`[annotation-outside] ${effect}`);
    } else if (covered < a.dur - 0.05) {
      out.push(
        `[annotation-outside] annotations[${i}] ${name} (${range}) is partly in cut footage; it is drawn only over the kept part (${shown.map((r) => `${fix(r.in)}s-${fix(r.out)}s`).join(", ")})`,
      );
    }
  });
  return out;
}

/** Checks that need the built timeline (narration freezes included). */
export function lintTimeline(sb: Storyboard, timeline: Timeline): string[] {
  if (sb.lint?.off?.includes("duration")) return [];
  const total = timeline.videoEnd + (sb.outro?.dur ?? 0);
  const max = sb.lint?.duration?.max ?? DURATION.max;
  const min = sb.lint?.duration?.min ?? DURATION.min;
  if (total > max) return [`[duration] the video is ${fix(total)}s long (over ${max}s); cut idle time or speed up segments`];
  if (total < min) return [`[duration] the video is only ${fix(total)}s long (under ${min}s); add pacing or a longer take`];
  return [];
}

/** Slowest speed-up of a voice clip that still sounds natural; the cap of the slot-fit check. */
export const DEFAULT_FIT_MAX = 1.18;

export interface FitEntry {
  /** The line's `id` (default: its position). */
  id: string;
  /** Position in `narration`. */
  index: number;
  /** Seconds of the voice clip as made. */
  raw: number;
  /** Seconds from the line's `at` to the next line's `at`, minus `voice.gap`. */
  slot: number;
  /** raw / slot: above 1 the line does not fit; 1.25 means it must be spoken 25% faster. */
  needed: number;
  /** Set by auto-fit: the speed-up the clip was given. */
  applied?: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The slot of every narration line but the last (it has no next line): the room before the next line starts,
 * less the silence `voice.gap` keeps between lines. Times are source seconds, as in the storyboard.
 */
export function fitLines(lines: { id: string; index: number; at: number; duration: number }[], gap: number): FitEntry[] {
  const sorted = [...lines].sort((a, b) => a.at - b.at || a.index - b.index);
  return sorted.slice(0, -1).map((l, k) => {
    const slot = Math.max(sorted[k + 1]!.at - l.at - gap, 0.01);
    return { id: l.id, index: l.index, raw: round3(l.duration), slot: round3(slot), needed: round3(l.duration / slot) };
  });
}

/** One `[narration-fit]` warning per line that needs more than the cap (a line exactly at the cap is fine). */
export function fitWarnings(entries: FitEntry[], max: number): string[] {
  const x = (n: number) => `${+n.toFixed(2)}x`;
  return entries
    .filter((e) => e.needed > max)
    .map((e) => {
      const head = `[narration-fit] narration "${e.id}" (narration[${e.index}]): the clip is ${+e.raw.toFixed(2)}s but its slot is ${+e.slot.toFixed(2)}s, so it needs a ${x(e.needed)} speed-up (over the ${x(max)} cap)`;
      return e.applied !== undefined
        ? `${head}; even sped up to ${x(e.applied)} it overruns, so the video freezes to make room. Shorten the text`
        : `${head}; shorten the text, or the video freezes to make room`;
    });
}
