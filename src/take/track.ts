import { performance } from "node:perf_hooks";
import { measure as measureWeb } from "../drive/web.js";
import type { Rect } from "../record/input/types.js";

/** Pixels added around the element so the highlight frames it instead of touching its edges. */
export const HIGHLIGHT_PAD = 6;
/** Seconds an element must stay not visible before its highlight ends (a re-render flicker is not an end). */
export const GONE_AFTER = 0.8;
/** Shorter tracked spans are dropped: a highlight that flashes is noise. */
export const MIN_SPAN = 0.6;

/** An element box in global logical px; `covered` when something else is on top of its centre. */
export type Measured = Rect & { covered: boolean };

export interface TrackedSpan {
  /** Seconds (the caller's clock) of the first visible sample. */
  at: number;
  end: number;
  /** Global logical px of the first visible sample. */
  rect: Rect;
}

/**
 * A global px rect → 0..1 of the recorded video: the same mapping as `normalizeEvents` (subtract the
 * recorded screen's origin, scale into the content rect), padded by `pad` px and clipped to 0..1.
 */
export function globalRectToRecording(r: Rect, screen: Rect, content: Rect, pad = HIGHLIGHT_PAD): Rect {
  const nx = (px: number) => content.x + ((px - screen.x) / screen.w) * content.w;
  const ny = (py: number) => content.y + ((py - screen.y) / screen.h) * content.h;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clip(nx(r.x - pad));
  const y0 = clip(ny(r.y - pad));
  const x1 = clip(nx(r.x + r.w + pad));
  const y1 = clip(ny(r.y + r.h + pad));
  return { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) };
}

/**
 * When a tracked element's span ends: the first time after `start` that it stays not visible
 * (missing, hidden or covered) for at least GONE_AFTER seconds, capped at `start + max`.
 * Samples are sorted by time.
 */
export function spanEnd(samples: { t: number; visible: boolean }[], start: number, max: number): number {
  const cap = start + max;
  let goneSince: number | undefined;
  for (const s of samples) {
    if (s.t < start) continue;
    if (s.visible) {
      goneSince = undefined;
      continue;
    }
    goneSince ??= s.t;
    if (s.t - goneSince >= GONE_AFTER - 1e-9) return Math.min(goneSince, cap);
  }
  return cap;
}

export interface TrackOptions {
  /** Clock seconds when tracking starts (the step's time); the span never goes past startedAt + max. */
  startedAt: number;
  max: number;
  intervalMs?: number;
  /** Aborting stops tracking (until "next", or the end of the take). */
  signal?: AbortSignal;
  /** Clock in seconds; default: startedAt plus the time since this call. */
  now?: () => number;
  /** Demo browser id the element is in (default "main"). */
  browser?: string;
  /** Default: `measure` in that demo browser. */
  measure?: (selector: string) => Promise<Measured | null>;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Follows a page element in the background: samples its box every `intervalMs` (250) until it is
 * gone for GONE_AFTER s, the cap, or the signal. The span starts at the first visible sample and
 * keeps that sample's rect. Null when the element never showed. Never rejects: a failed measure
 * (navigation, closed tab) counts as not visible.
 */
export async function trackElement(selector: string, o: TrackOptions): Promise<TrackedSpan | null> {
  const t0 = performance.now();
  const clock = o.now ?? (() => o.startedAt + (performance.now() - t0) / 1000);
  const measure = o.measure ?? ((s: string) => measureWeb(s, undefined, o.browser));
  const wait = o.wait ?? ((ms: number) => abortableSleep(ms, o.signal));
  const interval = o.intervalMs ?? 250;
  const cap = o.startedAt + o.max;
  const samples: { t: number; visible: boolean }[] = [];
  let first: { at: number; rect: Rect } | undefined;
  while (!o.signal?.aborted) {
    const t = clock();
    if (t >= cap) break;
    const m = await measure(selector).catch(() => null);
    const visible = !!m && !m.covered && m.w > 0 && m.h > 0;
    if (visible && !first) first = { at: t, rect: { x: m.x, y: m.y, w: m.w, h: m.h } };
    if (first) {
      samples.push({ t, visible });
      if (spanEnd(samples, first.at, cap - first.at) < cap) break;
    }
    await wait(interval);
  }
  if (!first) return null;
  const end = spanEnd(samples, first.at, cap - first.at);
  if (end < cap) return { ...first, end };
  // Stopped (cap or signal) before a confirmed end: end where it went missing, else where tracking stopped.
  let trailingGone: number | undefined;
  for (const s of samples) trailingGone = s.visible ? undefined : (trailingGone ?? s.t);
  return { ...first, end: trailingGone ?? Math.min(clock(), cap) };
}

export interface Tracked {
  selector: string;
  label?: string;
  span: TrackedSpan | null;
}

/**
 * Tracked spans (times in recording seconds, rects in global px) → `storyboard.highlights[]` in
 * recording coordinates (`meta.screen`, `meta.capture.contentRect`). A span that never showed, is
 * shorter than MIN_SPAN or lies outside the recorded area is dropped with a warning naming its selector.
 */
export function trackedHighlights(
  tracked: Tracked[],
  screen: Rect,
  content: Rect,
): { highlights: { at: number; dur: number; x: number; y: number; w: number; h: number; label?: string }[]; warnings: string[] } {
  const highlights: { at: number; dur: number; x: number; y: number; w: number; h: number; label?: string }[] = [];
  const warnings: string[] = [];
  for (const { selector, label, span } of tracked) {
    if (!span) {
      warnings.push(`highlight "${selector}": the element never showed, so it has no highlight`);
      continue;
    }
    const dur = span.end - span.at;
    if (dur < MIN_SPAN) {
      warnings.push(`highlight "${selector}": shown only ${dur.toFixed(2)} s (under ${MIN_SPAN} s), dropped`);
      continue;
    }
    const r = globalRectToRecording(span.rect, screen, content);
    if (r.w < 0.005 || r.h < 0.005) {
      warnings.push(`highlight "${selector}": the element is outside the recorded area, dropped`);
      continue;
    }
    const at = Math.max(0, Math.round(span.at * 100) / 100);
    highlights.push({ at, dur: Math.round(dur * 100) / 100, ...r, ...(label ? { label } : {}) });
  }
  return { highlights, warnings };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
  });
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
