import { type CardContent, MUSIC_FADE_IN, MUSIC_FADE_OUT, type MediaOverlay, type Motion, type Storyboard, type Theme, type View } from "../storyboard/schema.js";
import { cardDirection, cardTexts } from "./cards/index.js";
import type { Timeline } from "../storyboard/timeline.js";
import type { VoiceClip } from "../voice/index.js";
import { type DuckTween, planDuck } from "./duck.js";
import { pressFor, typingPresses } from "./typing.js";
import { type CamTween, FULL, planCamera, planViewCamera, type Rect, type ViewSpan, type ZoomSpan } from "./zoom.js";

// Everything the HTML generator needs, already in OUTPUT seconds.

/** Seconds typed text stays on screen after the last press. */
const KEYS_HOLD = 0.8;

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
  motion?: Motion;
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

interface Pt {
  x: number;
  y: number;
}

/** Arrows, boxes and blur on the recording; positions are 0..1 of the source (they live in the camera). */
export type AnnotationItem = { start: number; end: number } & (
  | { kind: "arrow"; from: Pt; to: Pt; label?: string; color: string; width: number; settled?: boolean }
  | { kind: "box"; x: number; y: number; w: number; h: number; shape: "box" | "ellipse"; label?: string; color: string; motion?: Motion; settled?: boolean }
  | { kind: "blur"; x: number; y: number; w: number; h: number; mode: "blur" | "solid"; strength: number; color: string }
);

/** One narration line as a subtitle cue (output seconds), whether or not it is burned into the picture. */
export interface SubtitleItem {
  /** The narration line's id (see timeline.json); set by renders, absent in plans built without one. */
  id?: string;
  start: number;
  end: number;
  text: string;
}

/** Typed text on screen: each word shows on the press that finishes it (output seconds). */
export interface KeysItem {
  start: number;
  end: number;
  words: { text: string; at: number }[];
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
  /** Seconds to skip at the start of the file (partial renders). */
  mediaStart?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Volume ramps (output seconds) that duck this item under the narration. */
  duck?: DuckTween[];
}

export interface CardItem {
  start: number;
  dur: number;
  /** Seconds the card cross-fades in over the previous picture (outro). */
  fadeIn: number;
  /** Seconds the card cross-fades out over the picture (chapter cards). */
  fadeOut?: number;
  title: string;
  subtitle?: string;
}

export interface OverlayItem {
  /** Path inside the build dir. */
  src: string;
  kind: "image" | "video";
  start: number;
  end: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fit: MediaOverlay["fit"];
  opacity: number;
  radius?: number;
  shadow?: boolean;
  motion?: Motion;
  /** Timed media elements: one for an image or a video that plays once, repeats when looping. */
  clips: { start: number; duration: number; /** Seconds to skip in the file (partial renders). */ mediaStart?: number }[];
}

/** A card overlay (kind "card") placed on the output timeline: drawn from its data by html.ts, no file involved. */
export type DataCardItem = CardContent & {
  id?: string;
  start: number;
  end: number;
  /** Reading direction and language, found from the card's text (cardDirection). */
  dir: "ltr" | "rtl";
  lang?: string;
  motion?: Motion;
};

/** An overlay file copied into the build dir. */
export interface OverlayAsset {
  src: string;
  kind: "image" | "video";
  /** Video length (s). */
  duration?: number;
  hasAudio?: boolean;
}

export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  duration: number;
  theme: Theme;
  video: { src: string; start: number; duration: number; hasAudio: boolean; mediaStart?: number };
  frame: Box;
  /** Pixel size of #cam: the FULL source video at the camera's base scale. */
  cam: { w: number; h: number };
  camera: CamTween[];
  texts: TextItem[];
  highlights: HighlightItem[];
  annotations: AnnotationItem[];
  keys: KeysItem[];
  /** Every narration line, for the .srt/.vtt files. */
  subtitles: SubtitleItem[];
  ripples: Ripple[];
  audio: AudioItem[];
  cards: CardItem[];
  overlays: OverlayItem[];
  /** Card overlays drawn from data (buildPlan always sets it; a plan written by hand may leave it out). */
  dataCards?: DataCardItem[];
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
  narration: (VoiceClip & { at: number; caption: boolean; src: string; id?: string })[];
  clicks: ClickEvent[];
  musicSrc?: string;
  /** Output seconds the prepared music track (music.ts) plays; its fades are already in the file. Without it the music spans the video. */
  musicClip?: { start: number; duration: number };
  /** One entry per storyboard.overlays item; undefined when its file is missing. */
  overlays?: (OverlayAsset | undefined)[];
  /** The mixed sound effects track (sfx.ts), as long as the video. */
  sfxSrc?: string;
}

/** Language of a voice name such as "ar-EG-SalmaNeural"; the local Egyptian Arabic voice "namaa" is Arabic too. */
function languageOfVoice(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const m = /^([a-z]{2,3})-[A-Za-z0-9]+/.exec(name);
  if (m) return m[1];
  return /^namaa/i.test(name) ? "ar" : undefined;
}

/** Seconds the outro cross-fades in over the end of the video. */
export function outroFadeIn(videoDuration: number): number {
  return round(Math.min(0.5, videoDuration / 4));
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

/**
 * Every view with the output time it takes effect. A view whose time was cut out
 * applies where the next kept moment starts; of views sharing one start only the
 * last (by `at`) stays, so the camera begins on the view current at that moment.
 * `views` must be sorted by `at`.
 */
function effectiveViews(views: View[], tl: Timeline): { view: View; start: number }[] {
  const out: { view: View; start: number }[] = [];
  for (const view of views) {
    const start = tl.toOutputOrNext(view.at);
    if (start === null) continue;
    if (out.at(-1)?.start === start) out.pop();
    out.push({ view, start });
  }
  return out;
}

export function buildPlan(input: PlanInput): RenderPlan {
  const { sb, timeline: tl } = input;
  const { width, height, fps } = sb.output;
  const offset = tl.offset;
  const outroDur = sb.outro?.dur ?? 0;
  const duration = round(tl.videoEnd + outroDur);
  const screens = new Map<string, Rect>(sb.screens.map((s) => [s.name, { x: s.x, y: s.y, w: s.w, h: s.h }]));
  const rectOf = (v: View): Rect | undefined => v.rect ?? (v.screen === "all" ? FULL : v.screen ? screens.get(v.screen) : undefined);
  const views = effectiveViews(
    sb.views.filter((v) => rectOf(v)).sort((a, b) => a.at - b.at),
    tl,
  );
  const firstRect = views[0] ? rectOf(views[0].view) : undefined;
  const srcW = input.source.width;
  const srcH = input.source.height;
  // A monitor view keeps its own shape; free-form (window) views use the output's shape.
  const frame = !firstRect
    ? frameBox(width, height, srcW, srcH, sb.theme.padding)
    : views[0]!.view.rect
      ? frameBox(width, height, width, height, sb.theme.padding)
      : frameBox(width, height, firstRect.w * srcW, firstRect.h * srcH, sb.theme.padding);
  // #cam holds the whole source, sized so the first view fits the frame at scale 1.
  let cam = { w: frame.w, h: frame.h };
  if (firstRect && views[0]!.view.rect) {
    const base = Math.max(frame.w / (firstRect.w * srcW), frame.h / (firstRect.h * srcH));
    cam = { w: srcW * base, h: srcH * base };
  } else if (firstRect) {
    cam = { w: frame.w / firstRect.w, h: frame.h / firstRect.h };
  }

  const spans: ZoomSpan[] = [];
  for (const z of sb.zooms) {
    const m = tl.mapSpan(z.at, z.dur);
    if (m) spans.push({ start: m.start, end: m.end, x: z.x, y: z.y, scale: z.scale });
  }

  function viewSpans(): ViewSpan[] {
    // Free-form (window) views fill the frame so nothing around the window shows.
    const out: ViewSpan[] = [{ start: 0, rect: firstRect!, cut: false, cover: !!views[0]!.view.rect }];
    for (const { view: v, start } of views.slice(1)) {
      out.push({ start, rect: rectOf(v)!, cut: v.transition === "cut", cover: !!v.rect });
    }
    return out;
  }

  const texts: TextItem[] = [];
  for (const c of sb.captions) {
    const m = tl.mapSpan(c.at, c.dur);
    if (!m) continue;
    texts.push({ start: m.start, end: m.end, text: c.text, position: c.position, style: c.style, x: c.x, y: c.y, motion: c.motion });
  }

  const audio: AudioItem[] = [];
  const subtitles: SubtitleItem[] = [];
  for (const n of input.narration) {
    const start = tl.toOutput(n.at);
    if (start === null) continue;
    subtitles.push({ ...(n.id !== undefined ? { id: n.id } : {}), start: round(start), end: round(start + n.duration), text: n.text });
    audio.push({ src: n.src, start: round(start), duration: round(n.duration), volume: sb.voice.volume });
    if (n.caption) {
      texts.push({ start, end: start + n.duration, text: n.text, position: "bottom", style: "subtitle" });
    }
  }
  let musicItem: AudioItem | undefined;
  if (input.musicSrc && sb.music) {
    musicItem = input.musicClip
      ? { src: input.musicSrc, start: input.musicClip.start, duration: input.musicClip.duration, volume: sb.music.volume }
      : { src: input.musicSrc, start: 0, duration, volume: sb.music.volume, fadeIn: sb.music.fadeIn ?? MUSIC_FADE_IN, fadeOut: sb.music.fadeOut ?? MUSIC_FADE_OUT };
    audio.push(musicItem);
  }
  // The voice lines that exist so far; overlay sound is added below, once the overlays are known.
  const narrationSpans = audio.filter((a) => a !== musicItem).map((a) => ({ start: a.start, end: a.start + a.duration }));
  const overlaySpans: { start: number; end: number }[] = [];

  if (input.sfxSrc) audio.push({ src: input.sfxSrc, start: 0, duration, volume: 1 });

  const overlays: OverlayItem[] = [];
  const dataCards: DataCardItem[] = [];
  const voiceLang = languageOfVoice(sb.voice.name);
  const firstIn = tl.pieces.find((p) => p.kind === "play")?.in ?? 0;
  sb.overlays.forEach((o, i) => {
    if (o.kind === "card") {
      const m = tl.mapSpan(o.at, o.dur);
      if (!m) return;
      const start = round(m.start);
      const end = round(m.end);
      if (end <= start) return;
      const content = { template: o.template, data: o.data } as CardContent;
      dataCards.push({
        ...content,
        ...(o.id !== undefined ? { id: o.id } : {}),
        start,
        end,
        ...cardDirection(cardTexts(content), { lang: o.lang, voiceLang }),
        ...(o.motion ? { motion: o.motion } : {}),
      });
      return;
    }
    const asset = input.overlays?.[i];
    if (!asset) return;
    let start: number;
    let end: number;
    if (o.at === undefined && o.dur === undefined) {
      start = tl.offset;
      end = tl.videoEnd;
    } else {
      const m = tl.mapSpan(o.at ?? firstIn, o.dur ?? 0);
      if (!m) return;
      start = m.start;
      end = o.dur === undefined ? tl.videoEnd : m.end;
    }
    start = round(start);
    end = round(end);
    if (end <= start) return;
    const clips = overlayClips(start, end, asset, o.loop);
    overlays.push({
      src: asset.src,
      kind: asset.kind,
      start,
      end,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      fit: o.fit,
      opacity: o.opacity,
      radius: o.radius,
      shadow: o.shadow,
      motion: o.motion,
      clips,
    });
    if (asset.kind === "video" && asset.hasAudio && !o.mute) {
      for (const c of clips) {
        audio.push({ src: asset.src, start: c.start, duration: c.duration, volume: 1 });
        overlaySpans.push({ start: c.start, end: c.start + c.duration });
      }
    }
  });

  if (musicItem && sb.music?.duck) {
    const under = sb.music.duck.under ?? ["narration"];
    const spans = [...(under.includes("narration") ? narrationSpans : []), ...(under.includes("overlays") ? overlaySpans : [])];
    const duck = planDuck(spans, sb.music.volume, sb.music.duck, duration);
    if (duck.length > 0) musicItem.duck = duck;
  }

  const highlights: HighlightItem[] = [];
  for (const h of sb.highlights) {
    const m = tl.mapSpan(h.at, h.dur);
    if (m) highlights.push({ start: m.start, end: m.end, x: h.x, y: h.y, w: h.w, h: h.h, label: h.label });
  }

  const annotations: AnnotationItem[] = [];
  for (const a of sb.annotations) {
    const m = tl.mapSpan(a.at, a.dur);
    if (!m) continue;
    const span = { start: m.start, end: m.end };
    if (a.type === "arrow") annotations.push({ ...span, kind: "arrow", from: a.from, to: a.to, label: a.label, color: a.color ?? sb.theme.accent, width: a.width });
    else if (a.type === "box") {
      annotations.push({ ...span, kind: "box", x: a.x, y: a.y, w: a.w, h: a.h, shape: a.shape, label: a.label, color: a.color ?? sb.theme.accent, motion: a.motion });
    } else annotations.push({ ...span, kind: "blur", x: a.x, y: a.y, w: a.w, h: a.h, mode: a.mode, strength: a.strength, color: a.color ?? "#0b0b0b" });
  }

  const keys: KeysItem[] = [];
  sb.typing.forEach((t, i) => {
    if (!t.keycaps || !t.text) return;
    const presses = typingPresses(t, i);
    const mapped = presses.map((p) => tl.toOutput(p));
    if (mapped.every((x) => x === null)) return;
    // A press in a cut region shows with the next one that is still there.
    let next: number | null = null;
    for (let k = mapped.length - 1; k >= 0; k--) {
      if (mapped[k] === null) mapped[k] = next;
      else next = mapped[k]!;
    }
    const at = (k: number) => round(mapped[Math.min(k, mapped.length - 1)] ?? next ?? 0);
    const text = t.text;
    const words = [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: at(pressFor(m.index! + m[0].length - 1, text.length, mapped.length)) }));
    if (words.length === 0) return;
    const last = words.at(-1)!.at;
    keys.push({ start: round(tl.toOutput(t.at) ?? words[0]!.at), end: round(Math.min(last + KEYS_HOLD, duration)), words });
  });

  const ripples: Ripple[] = [];
  if (sb.theme.clickRipples) {
    for (const c of input.clicks) {
      const t = tl.toOutput(c.t);
      if (t !== null) ripples.push({ t: round(t), x: c.x, y: c.y });
    }
  }

  const cards: CardItem[] = [];
  if (sb.intro) cards.push({ start: 0, dur: sb.intro.dur, fadeIn: 0, title: sb.intro.title, subtitle: sb.intro.subtitle });
  for (const span of tl.cardSpans()) {
    const c = sb.cards[span.card]!;
    // The video is frozen under the card, so it fades in and out over the held frame.
    const fade = round(Math.min(0.3, (span.end - span.start) / 3));
    cards.push({ start: round(span.start), dur: round(span.end - span.start), fadeIn: fade, fadeOut: fade, title: c.title, subtitle: c.subtitle });
  }
  if (sb.outro) {
    // Overlap the last moment of the video so the outro cross-fades in.
    const fadeIn = outroFadeIn(tl.videoDuration);
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
    annotations,
    keys,
    subtitles: subtitles.sort((a, b) => a.start - b.start),
    ripples,
    audio,
    cards,
    overlays,
    dataCards,
  };
}

/** A video plays once, or repeats while looping; an image (or a video of unknown length) just spans. */
function overlayClips(start: number, end: number, asset: OverlayAsset, loop: boolean): { start: number; duration: number }[] {
  const len = asset.kind === "video" && asset.duration && asset.duration > 0 ? asset.duration : end - start;
  const clips: { start: number; duration: number }[] = [];
  for (let t = start; t < end - 1e-6; t += len) {
    clips.push({ start: round(t), duration: round(Math.min(len, end - t)) });
    if (!loop || len >= end - start) break;
  }
  return clips;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
