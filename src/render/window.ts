import type { AudioItem, CardItem, RenderPlan } from "./plan.js";
import type { CamState, CamTween } from "./zoom.js";
import { IDENTITY } from "./zoom.js";

// Partial render: HyperFrames has no frame or time range option, so a review
// window is rendered by shifting the plan (all of it is in output seconds) so
// the window starts at 0, dropping what falls outside and trimming media with
// data-media-start. The result is a shorter composition, not a cut of the file.

export interface Window {
  /** Output seconds. */
  from: number;
  /** Output seconds; open ended = to the end of the video. */
  to?: number;
}

export function parseWindow(from: number | undefined, to: number | undefined): Window | undefined {
  if (from === undefined && to === undefined) return undefined;
  const start = from ?? 0;
  if (!Number.isFinite(start) || start < 0) throw new Error(`--from must be a number of seconds >= 0 (got ${from})`);
  if (to !== undefined && (!Number.isFinite(to) || to <= start)) throw new Error(`--to must be greater than --from (got from ${start}, to ${to})`);
  return { from: start, to };
}

/** File name part for a window, e.g. ".part-12-20". */
export function partSuffix(w: Window): string {
  return `.part-${w.from}-${w.to ?? "end"}`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** GSAP "power2.inOut" at progress p (the camera's ease). */
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

/** Portion of [start, end] inside [from, to], as window-relative start and length. */
function clip(start: number, end: number, from: number, to: number): { start: number; dur: number; headCut: number; tailCut: boolean } | null {
  const s = Math.max(start, from);
  const e = Math.min(end, to);
  if (e - s <= 1e-6) return null;
  return { start: round(s - from), dur: round(e - s), headCut: round(s - start), tailCut: e < end };
}

export function windowPlan(plan: RenderPlan, win: Window): RenderPlan {
  const { from } = win;
  if (from >= plan.duration) throw new Error(`--from ${from}s is past the end of the video (${plan.duration}s)`);
  const to = Math.min(win.to ?? plan.duration, plan.duration);
  const shift = (t: number) => round(t - from);

  const v = plan.video;
  const vc = clip(v.start, v.start + v.duration, from, to);
  const video = vc
    ? { ...v, start: vc.start, duration: vc.dur, mediaStart: round((v.mediaStart ?? 0) + vc.headCut) }
    : { ...v, start: 0, duration: 0, mediaStart: 0 };

  const audio: AudioItem[] = [];
  for (const a of plan.audio) {
    const c = clip(a.start, a.start + a.duration, from, to);
    if (!c) continue;
    const { fadeIn, fadeOut, ...rest } = a;
    audio.push({
      ...rest,
      start: c.start,
      duration: c.dur,
      ...(c.headCut > 0 ? { mediaStart: round((a.mediaStart ?? 0) + c.headCut) } : {}),
      ...(fadeIn && c.headCut === 0 ? { fadeIn } : {}),
      ...(fadeOut && !c.tailCut ? { fadeOut } : {}),
    });
  }

  const cards: CardItem[] = [];
  for (const card of plan.cards) {
    const c = clip(card.start, card.start + card.dur, from, to);
    if (c) cards.push({ ...card, start: c.start, dur: c.dur, fadeIn: c.headCut > 0 ? 0 : card.fadeIn });
  }

  return {
    ...plan,
    duration: round(to - from),
    video,
    audio,
    cards,
    camera: windowCamera(plan.camera, from, to),
    texts: plan.texts.flatMap((t) => {
      const c = clip(t.start, t.end, from, to);
      return c ? [{ ...t, start: c.start, end: round(c.start + c.dur) }] : [];
    }),
    highlights: plan.highlights.flatMap((h) => {
      const c = clip(h.start, h.end, from, to);
      return c ? [{ ...h, start: c.start, end: round(c.start + c.dur) }] : [];
    }),
    ripples: plan.ripples.filter((r) => r.t >= from && r.t < to).map((r) => ({ ...r, t: shift(r.t) })),
  };
}

/** Camera tweens for the window: rest where the full render is at `from`, then the later moves. */
function windowCamera(camera: CamTween[], from: number, to: number): CamTween[] {
  if (from === 0) return camera;
  let state: CamState = IDENTITY;
  let moved = false;
  const out: CamTween[] = [];
  const sorted = [...camera].sort((a, b) => a.t - b.t);
  for (const tw of sorted) {
    const target: CamState = { x: tw.x, y: tw.y, scale: tw.scale };
    if (tw.t + tw.dur <= from) {
      state = target;
      moved = true;
    } else if (tw.t < from) {
      // Mid-move at the window start: begin at the eased in-between pose, finish the move.
      const k = easeInOut((from - tw.t) / tw.dur);
      state = {
        x: round(state.x + (target.x - state.x) * k),
        y: round(state.y + (target.y - state.y) * k),
        scale: round(state.scale + (target.scale - state.scale) * k),
      };
      moved = true;
      out.push({ t: 0, dur: round(tw.t + tw.dur - from), ...target });
    } else if (tw.t < to) {
      out.push({ ...tw, t: round(tw.t - from) });
    }
  }
  return moved ? [{ t: 0, dur: 0, ...state }, ...out] : out;
}
