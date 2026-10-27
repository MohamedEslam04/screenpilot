// Camera moves for the recording frame. The frame element has transform-origin
// 0 0, so a GSAP {x, y, scale} puts frame point p at (x + scale*p.x, y + scale*p.y).

export interface CamState {
  x: number;
  y: number;
  scale: number;
}

export interface CamTween extends CamState {
  t: number;
  dur: number;
}

export interface ZoomSpan {
  start: number;
  end: number;
  x: number; // normalized focus 0..1
  y: number;
  scale: number;
}

export const IDENTITY: CamState = { x: 0, y: 0, scale: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Transform that centers normalized point (fx, fy) without showing past the edges. */
export function camFor(fx: number, fy: number, scale: number, w: number, h: number): CamState {
  const x = clamp(w / 2 - scale * fx * w, w * (1 - scale), 0);
  const y = clamp(h / 2 - scale * fy * h, h * (1 - scale), 0);
  return { x: round(x), y: round(y), scale };
}

/**
 * Turn zoom spans into tweens. Each zoom eases in so it is fully in at
 * `start`, holds until `end`, then eases out — unless the next zoom starts
 * soon, in which case the camera pans straight to it.
 */
export function planCamera(
  spans: ZoomSpan[],
  w: number,
  h: number,
  opts: { transition?: number; panGap?: number } = {},
): CamTween[] {
  const tr = opts.transition ?? 0.6;
  const panGap = opts.panGap ?? 1.2;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const tweens: CamTween[] = [];
  let busyUntil = 0;

  sorted.forEach((z, i) => {
    const target = camFor(z.x, z.y, z.scale, w, h);
    const t = Math.max(busyUntil, z.start - tr, 0);
    const dur = Math.max(0.2, Math.min(tr, z.end - t));
    tweens.push({ t: round(t), dur: round(dur), ...target });
    busyUntil = t + dur;

    const next = sorted[i + 1];
    if (!next || next.start - tr - z.end > panGap) {
      const outT = Math.max(z.end, busyUntil);
      tweens.push({ t: round(outT), dur: tr, ...IDENTITY });
      busyUntil = outT + tr;
    } else {
      busyUntil = Math.max(busyUntil, z.end);
    }
  });
  return tweens;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewSpan {
  start: number; // output seconds; the first view is the initial one, its start is ignored
  rect: Rect; // normalized to the full source video
  cut: boolean;
  /** Fill the frame with the rect, trimming its edges (windows), instead of showing all of it (monitors). */
  cover?: boolean;
}

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Transform that fits normalized `rect` of the full video (drawn `cam` px big
 * in its own box) inside `frame`, centered. Letterboxes when aspects differ,
 * or with `cover` fills the frame and trims the rect's longer side instead.
 */
export function camForRect(rect: Rect, frame: { w: number; h: number }, cam: { w: number; h: number }, cover = false): CamState {
  const sx = frame.w / (rect.w * cam.w);
  const sy = frame.h / (rect.h * cam.h);
  const scale = cover ? Math.max(sx, sy) : Math.min(sx, sy);
  const x = frame.w / 2 - scale * (rect.x + rect.w / 2) * cam.w;
  const y = frame.h / 2 - scale * (rect.y + rect.h / 2) * cam.h;
  return { x: round(x), y: round(y), scale: round(scale) };
}

/** Zoom rect: view/scale centered on the focus point, kept inside the view. */
export function zoomRect(view: Rect, fx: number, fy: number, scale: number): Rect {
  const w = view.w / scale;
  const h = view.h / scale;
  return {
    x: clamp(fx - w / 2, view.x, view.x + view.w - w),
    y: clamp(fy - h / 2, view.y, view.y + view.h - h),
    w,
    h,
  };
}

/**
 * Camera for a multi-monitor recording: `views[0]` is the initial view, later
 * ones pan (or cut) to their rect; zooms are relative to the active view and
 * return to it. Mirrors planCamera's zoom-in / pan-between-close-zooms rules.
 */
export function planViewCamera(
  views: ViewSpan[],
  spans: ZoomSpan[],
  frame: { w: number; h: number },
  cam: { w: number; h: number },
  opts: { transition?: number; panGap?: number; pan?: number } = {},
): CamTween[] {
  const tr = opts.transition ?? 0.6;
  const panGap = opts.panGap ?? 1.2;
  const pan = opts.pan ?? 0.8;
  const [first, ...rest] = [...views].sort((a, b) => a.start - b.start);
  if (!first) return [];
  let view = first.rect;
  let cover = first.cover ?? false;
  const tweens: CamTween[] = [{ t: 0, dur: 0, ...camForRect(view, frame, cam, cover) }];
  type Ev = { at: number; view: ViewSpan } | { at: number; zoom: ZoomSpan };
  const events: Ev[] = [
    ...rest.map((v) => ({ at: v.start, view: v })),
    ...spans.map((z) => ({ at: z.start, zoom: z })),
  ].sort((a, b) => a.at - b.at);
  let busyUntil = 0;

  events.forEach((ev, i) => {
    if ("view" in ev) {
      view = ev.view.rect;
      cover = ev.view.cover ?? false;
      const target = camForRect(view, frame, cam, cover);
      if (ev.view.cut) {
        const t = ev.view.start;
        // A running tween must not fight the instant set.
        for (let k = tweens.length - 1; k > 0; k--) {
          const tw = tweens[k]!;
          if (tw.t >= t) tweens.splice(k, 1);
          else if (tw.t + tw.dur > t) tw.dur = round(t - tw.t);
        }
        tweens.push({ t: round(t), dur: 0, ...target });
        busyUntil = t;
      } else {
        const t = Math.max(busyUntil, ev.view.start);
        tweens.push({ t: round(t), dur: pan, ...target });
        busyUntil = t + pan;
      }
      return;
    }
    const z = ev.zoom;
    const target = camForRect(zoomRect(view, z.x, z.y, z.scale), frame, cam, cover);
    const t = Math.max(busyUntil, z.start - tr, 0);
    const dur = Math.max(0.2, Math.min(tr, z.end - t));
    tweens.push({ t: round(t), dur: round(dur), ...target });
    busyUntil = t + dur;

    const next = events[i + 1];
    const gap = next ? next.at - tr - z.end : Infinity;
    const nextIsView = next !== undefined && "view" in next;
    if (!next || (nextIsView ? next.at - z.end > panGap : gap > panGap)) {
      const outT = Math.max(z.end, busyUntil);
      tweens.push({ t: round(outT), dur: tr, ...camForRect(view, frame, cam, cover) });
      busyUntil = outT + tr;
    } else {
      busyUntil = Math.max(busyUntil, z.end);
    }
  });
  return tweens;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
