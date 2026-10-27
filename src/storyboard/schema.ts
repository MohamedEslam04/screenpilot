import { z } from "zod";
import { APP } from "../brand.js";

// All times are in SOURCE seconds (the raw recording), so the agent can reason
// about what it sees in extracted frames. Positions are normalized 0..1 of the
// source video (x from left, y from top). The renderer maps both to output.

const time = z.number().min(0);
const norm = z.number().min(0).max(1);

export const SegmentSchema = z
  .object({
    in: time.describe("Source start (s)"),
    out: time.describe("Source end (s)"),
    speed: z.number().min(0.25).max(16).default(1).describe("Playback speed; >1 fast-forwards boring parts"),
  })
  .refine((s) => s.out > s.in, { message: "segment.out must be greater than segment.in" });

export const HoldSchema = z.object({
  at: time.describe("Source time to freeze on"),
  dur: z.number().positive().describe("Freeze length (s)"),
});

export const ZoomSchema = z.object({
  at: time.describe("Source time the zoom is fully in"),
  dur: z.number().positive().describe("How long to stay zoomed (s)"),
  x: norm.describe("Focus point x, 0..1"),
  y: norm.describe("Focus point y, 0..1"),
  scale: z.number().min(1).max(4).default(1.8),
});

export const ScreenSchema = z.object({
  name: z.string().min(1).describe("Monitor name, e.g. eDP-1"),
  x: norm,
  y: norm,
  w: norm.refine((v) => v > 0, { message: "screen.w must be > 0" }),
  h: norm.refine((v) => v > 0, { message: "screen.h must be > 0" }),
});

export const RectSchema = z.object({ x: norm, y: norm, w: norm, h: norm });

export const ViewSchema = z
  .object({
    at: time.describe("Source time the camera moves to this view"),
    screen: z.string().min(1).optional().describe('A screens[].name, or "all" for the whole recording'),
    rect: RectSchema.optional().describe("Any region (0..1 of the source), e.g. the window being used"),
    label: z.string().optional().describe("What the rect is, e.g. a window title (informational)"),
    transition: z.enum(["pan", "cut"]).default("pan"),
  })
  .refine((v) => (v.screen === undefined) !== (v.rect === undefined), { message: "a view needs exactly one of screen or rect" });

export const CaptionSchema = z.object({
  at: time,
  dur: z.number().positive().default(3),
  text: z.string().min(1),
  position: z.enum(["bottom", "top", "center"]).default("bottom"),
  style: z.enum(["pill", "title", "callout"]).default("pill"),
  // Only for style "callout": anchor point the bubble points at.
  x: norm.optional(),
  y: norm.optional(),
});

export const NarrationSchema = z.object({
  at: time.describe("Source time the line starts"),
  text: z.string().min(1),
  voice: z.string().optional().describe("Override voice, e.g. ar-EG-ShakirNeural"),
  caption: z.boolean().optional().describe("Also show the line as a subtitle (default from voice.subtitles)"),
});

export const HighlightSchema = z.object({
  at: time,
  dur: z.number().positive().default(2),
  x: norm,
  y: norm,
  w: norm,
  h: norm,
  label: z.string().optional(),
});

export const CardSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  dur: z.number().positive().default(3),
});

export const ThemeSchema = z.object({
  background: z.string().default("linear-gradient(135deg, #1e1b4b 0%, #4338ca 55%, #0ea5e9 100%)"),
  padding: z.number().min(0).max(0.2).default(0.05).describe("Space around the recording, fraction of output width"),
  radius: z.number().min(0).max(60).default(16),
  shadow: z.boolean().default(true),
  accent: z.string().default("#facc15"),
  font: z.string().default("'Inter', 'Cairo', system-ui, sans-serif"),
  captionColor: z.string().default("#ffffff"),
  captionBackground: z.string().default("rgba(15, 23, 42, 0.82)"),
  clickRipples: z.boolean().default(true).describe("Draw a ripple on every recorded click (needs events.jsonl)"),
});

export const VoiceSchema = z.object({
  provider: z.enum(["edge"]).default("edge"),
  name: z.string().default("en-US-AndrewNeural"),
  rate: z.string().default("+0%").describe("SSML rate, e.g. +10% or -5%"),
  subtitles: z.boolean().default(true).describe("Show narration lines as subtitles"),
  gap: z.number().min(0).default(0.3).describe("Min silence between lines; video freezes to make room"),
  volume: z.number().min(0).max(4).default(1),
});

export const OutputSchema = z.object({
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  fps: z.number().int().min(1).max(120).default(30),
});

export const MusicSchema = z.object({
  src: z.string(),
  volume: z.number().min(0).max(1).default(0.12),
});

export const StoryboardSchema = z.object({
  version: z.literal(1).default(1),
  source: z.string().describe("Path to the raw recording, relative to the storyboard file"),
  events: z.string().optional().describe(`events.jsonl from \`${APP} record\`, relative path`),
  keepSourceAudio: z.boolean().default(false),
  output: OutputSchema.prefault({}),
  theme: ThemeSchema.prefault({}),
  voice: VoiceSchema.prefault({}),
  segments: z.array(SegmentSchema).default([]).describe("Parts of the source to keep, in order. Empty = whole video"),
  holds: z.array(HoldSchema).default([]),
  zooms: z.array(ZoomSchema).default([]),
  screens: z.array(ScreenSchema).default([]).describe("Monitor rects (0..1 of the source) in a multi-monitor recording"),
  views: z.array(ViewSchema).default([]).describe("Camera follows the action: which screen is shown from each time on"),
  captions: z.array(CaptionSchema).default([]),
  highlights: z.array(HighlightSchema).default([]),
  narration: z.array(NarrationSchema).default([]),
  intro: CardSchema.optional(),
  outro: CardSchema.optional(),
  music: MusicSchema.optional(),
});

export type Storyboard = z.output<typeof StoryboardSchema>;
export type StoryboardInput = z.input<typeof StoryboardSchema>;
export type Segment = z.output<typeof SegmentSchema>;
export type Hold = z.output<typeof HoldSchema>;
export type Zoom = z.output<typeof ZoomSchema>;
export type Screen = z.output<typeof ScreenSchema>;
export type View = z.output<typeof ViewSchema>;
export type Caption = z.output<typeof CaptionSchema>;
export type Narration = z.output<typeof NarrationSchema>;
export type Highlight = z.output<typeof HighlightSchema>;
export type Theme = z.output<typeof ThemeSchema>;

export function storyboardJsonSchema(): unknown {
  return z.toJSONSchema(StoryboardSchema, { io: "input" });
}
