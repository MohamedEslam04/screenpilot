import type { Storyboard, Theme } from "../storyboard/schema.js";
import type { Timeline } from "../storyboard/timeline.js";
import type { VoiceClip } from "../voice/index.js";
import { type CamTween, FULL, planCamera, planViewCamera, type Rect, type ViewSpan, type ZoomSpan } from "./zoom.js";

// Everything the HTML generator needs, already in OUTPUT seconds.

export interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

export interface TextItem {
  start: number;
  end: number;
  text: string;
  position: "bottom" | "top" | "center";
  style: "pill" | "title" | "callout" | "subtitle";
  x?: number;
  y?: number;
}

export interface HighlightItem {
  start: number;
  end: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

export interface Ripple {
  t: number;
  x: number;
  y: number;
}

export interface AudioItem {
  src: string;
  start: number;
  duration: number;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface CardItem {
  start: number;
  dur: number;
  /** Seconds the card cross-fades in over the previous picture (outro). */
  fadeIn: number;
  title: string;
  subtitle?: string;
}

export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  duration: number;
  theme: Theme;
  video: { src: string; start: number; duration: number; hasAudio: boolean };
  frame: Box;
  /** Pixel size of #cam: the FULL source video at the camera's base scale. */
  cam: { w: number; h: number };
  camera: CamTween[];
  texts: TextItem[];
  highlights: HighlightItem[];
  ripples: Ripple[];
  audio: AudioItem[];
  cards: CardItem[];
}

export interface ClickEvent {
  t: number;
  x: number;
  y: number;
}

export interface PlanInput {
  sb: Storyboard;
  timeline: Timeline;
  editedSrc: string;
  editedHasAudio: boolean;
  source: { width: number; height: number };
  narration: (VoiceClip & { at: number; caption: boolean; src: string })[];
  clicks: ClickEvent[];
  musicSrc?: string;
}

/** Fit the recording inside the output with the theme's padding. */
export function frameBox(outW: number, outH: number, srcW: number, srcH: number, padding: number): Box {
  const pad = Math.round(outW * padding);
  const availW = outW - 2 * pad;
  const availH = outH - 2 * pad;
  const scale = Math.min(availW / srcW, availH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { left: Math.round((outW - w) / 2), top: Math.round((outH - h) / 2), w, h };
}

export function buildPlan(input: PlanInput): RenderPlan {
  const { sb, timeline: tl } = input;
  const { width, height, fps } = sb.output;
  const offset = tl.offset;
  const outroDur = sb.outro?.dur ?? 0;
  const duration = round(tl.videoEnd + outroDur);
  const screens = new Map<string, Rect>(sb.screens.map((s) => [s.name, { x: s.x, y: s.y, w: s.w, h: s.h }]));
  const rectOf = (name: string) => (name === "all" ? FULL : screens.get(name));
  const views = sb.views.filter((v) => rectOf(v.screen)).sort((a, b) => a.at - b.at);
  const firstRect = views[0] ? rectOf(views[0].screen)! : undefined;
  const frame = firstRect
    ? frameBox(width, height, firstRect.w * input.source.width, firstRect.h * input.source.height, sb.theme.padding)
    : frameBox(width, height, input.source.width, input.source.height, sb.theme.padding);
  const cam = firstRect ? { w: frame.w / firstRect.w, h: frame.h / firstRect.h } : { w: frame.w, h: frame.h };

  const spans: ZoomSpan[] = [];
  for (const z of sb.zooms) {
    const m = tl.mapSpan(z.at, z.dur);
    if (m) spans.push({ start: m.start, end: m.end, x: z.x, y: z.y, scale: z.scale });
  }

  function viewSpans(): ViewSpan[] {
    const out: ViewSpan[] = [{ start: 0, rect: firstRect!, cut: false }];
    for (const v of views.slice(1)) {
      const t = tl.toOutput(v.at);
      if (t !== null) out.push({ start: t, rect: rectOf(v.screen)!, cut: v.transition === "cut" });
    }
    return out;
  }

  const texts: TextItem[] = [];
  for (const c of sb.captions) {
    const m = tl.mapSpan(c.at, c.dur);
    if (!m) continue;
    texts.push({ start: m.start, end: m.end, text: c.text, position: c.position, style: c.style, x: c.x, y: c.y });
  }

  const audio: AudioItem[] = [];
  for (const n of input.narration) {
    const start = tl.toOutput(n.at);
    if (start === null) continue;
    audio.push({ src: n.src, start: round(start), duration: round(n.duration), volume: sb.voice.volume });
    if (n.caption) {
      texts.push({ start, end: start + n.duration, text: n.text, position: "bottom", style: "subtitle" });
    }
  }
  if (input.musicSrc && sb.music) {
    audio.push({ src: input.musicSrc, start: 0, duration, volume: sb.music.volume, fadeIn: 1, fadeOut: 2 });
  }

  const highlights: HighlightItem[] = [];
  for (const h of sb.highlights) {
    const m = tl.mapSpan(h.at, h.dur);
    if (m) highlights.push({ start: m.start, end: m.end, x: h.x, y: h.y, w: h.w, h: h.h, label: h.label });
  }

  const ripples: Ripple[] = [];
  if (sb.theme.clickRipples) {
    for (const c of input.clicks) {
      const t = tl.toOutput(c.t);
      if (t !== null) ripples.push({ t: round(t), x: c.x, y: c.y });
    }
  }

  const cards: CardItem[] = [];
  if (sb.intro) cards.push({ start: 0, dur: sb.intro.dur, fadeIn: 0, title: sb.intro.title, subtitle: sb.intro.subtitle });
  if (sb.outro) {
    // Overlap the last moment of the video so the outro cross-fades in.
    const fadeIn = round(Math.min(0.5, tl.videoDuration / 4));
    cards.push({
      start: round(tl.videoEnd - fadeIn),
      dur: round(outroDur + fadeIn),
      fadeIn,
      title: sb.outro.title,
      subtitle: sb.outro.subtitle,
    });
  }

  return {
    width,
    height,
    fps,
    duration,
    theme: sb.theme,
    video: { src: input.editedSrc, start: offset, duration: round(tl.videoDuration), hasAudio: input.editedHasAudio },
    frame,
    cam,
    camera: firstRect ? planViewCamera(viewSpans(), spans, frame, cam) : planCamera(spans, frame.w, frame.h),
    texts: texts.map((t) => ({ ...t, start: round(t.start), end: round(t.end) })).sort((a, b) => a.start - b.start),
    highlights,
    ripples,
    audio,
    cards,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
