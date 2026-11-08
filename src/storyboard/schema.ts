import { z } from "zod";
import { APP } from "../brand.js";

// All times are in SOURCE seconds (the raw recording), so the agent can reason
// about what it sees in extracted frames. Positions are normalized 0..1 of the
// source video (x from left, y from top). The renderer maps both to output.

const time = z.number().min(0);
const norm = z.number().min(0).max(1);

export const SegmentTransitionSchema = z.object({
  type: z.enum(["crossfade", "fade-black", "fade-white", "wipe-left", "wipe-right", "slide-left", "slide-right"]).describe("How this segment comes in over the end of the one before it"),
  dur: z.number().min(0.1).max(3).default(0.5).describe("Seconds the two overlap (at most half of either piece); the video gets this much shorter"),
});

export const SegmentSchema = z
  .object({
    in: time.describe("Source start (s)"),
    out: time.describe("Source end (s)"),
    speed: z.number().min(0.25).max(16).default(1).describe("Playback speed; >1 fast-forwards boring parts"),
    speedTo: z
      .number()
      .min(0.25)
      .max(16)
      .optional()
      .describe("Ramp the speed from `speed` at the start of the segment to this by its end (eases in or out of a fast-forward); needs a segment of a second or more"),
    volume: z.number().min(0).max(4).optional().describe("Source audio level of this segment (default 1); needs keepSourceAudio"),
    mute: z.boolean().optional().describe("Silence this segment's source audio (same as volume 0)"),
    transition: SegmentTransitionSchema.optional().describe("Blend into this segment instead of a hard cut (ignored on the first segment)"),
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

export const MOTION_PRESETS = ["none", "fade", "rise", "drop", "slide-left", "slide-right", "pop", "zoom", "blur", "wipe", "words", "lines"] as const;

export const MotionSchema = z
  .object({
    in: z.enum(MOTION_PRESETS).optional().describe("Entrance: words/lines reveal one word/line at a time (any script, Arabic too); wipe uncovers in reading direction"),
    out: z.enum(MOTION_PRESETS).optional().describe("Exit (words/lines exit like fade)"),
    duration: z.number().min(0).max(3).optional().describe("Seconds per entrance (default 0.3)"),
    ease: z.string().optional().describe('GSAP ease, e.g. "power3.out", "back.out(1.7)", "expo.out", "elastic.out(1,0.5)"'),
    stagger: z.number().min(0).max(1).optional().describe("Seconds between words/lines for words/lines (default 0.08)"),
  })
  .describe("How text moves in and out; the agent picks it to fit the video");

export const CaptionSchema = z.object({
  at: time,
  dur: z.number().positive().default(3),
  text: z.string().min(1),
  position: z.enum(["bottom", "top", "center"]).default("bottom"),
  style: z.enum(["pill", "title", "callout"]).default("pill"),
  motion: MotionSchema.optional().describe("Overrides theme.motion.captions for this caption"),
  // Only for style "callout": anchor point the bubble points at.
  x: norm.optional(),
  y: norm.optional(),
});

export const NarrationSchema = z.object({
  at: time.describe("Source time the line starts"),
  text: z.string().min(1),
  voice: z.string().optional().describe("Override voice, e.g. ar-EG-ShakirNeural"),
  caption: z.boolean().optional().describe("Also show the line as a subtitle (default from voice.subtitles)"),
  audio: z.string().optional().describe("Ready-made audio file for this line (path relative to the storyboard). Used instead of a voice; text is still the subtitle"),
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

const point = z.object({ x: norm, y: norm });
const annotationTime = { at: time, dur: z.number().positive().default(3) };
const annotationRect = {
  x: norm,
  y: norm,
  w: norm.refine((v) => v > 0, { message: "w must be > 0" }),
  h: norm.refine((v) => v > 0, { message: "h must be > 0" }),
};

export const AnnotationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("arrow"),
    ...annotationTime,
    from: point.describe("Tail of the arrow, 0..1 of the recording"),
    to: point.describe("Tip of the arrow (what it points at), 0..1 of the recording"),
    label: z.string().optional().describe("Text at the tail"),
    color: z.string().min(1).optional().describe("CSS color (default: theme.accent)"),
    width: z.number().min(2).max(24).default(8).describe("Line width in px"),
  }),
  z.object({
    type: z.literal("box"),
    ...annotationTime,
    ...annotationRect,
    shape: z.enum(["box", "ellipse"]).default("box"),
    label: z.string().optional(),
    color: z.string().min(1).optional().describe("CSS color (default: theme.accent)"),
    motion: MotionSchema.optional().describe("Entrance and exit (default pop in, fade out)"),
  }),
  z.object({
    type: z.literal("blur"),
    ...annotationTime,
    ...annotationRect,
    mode: z.enum(["blur", "solid"]).default("blur").describe("blur hides detail; solid covers it completely (use it for anything secret)"),
    strength: z.number().min(2).max(80).default(18).describe("Blur radius in px (mode blur)"),
    color: z.string().min(1).optional().describe("Fill for mode solid (default near-black)"),
  }),
]);

export const CardSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  dur: z.number().positive().default(3),
});

export const OverlaySchema = z.object({
  src: z.string().min(1).describe("Image or video, relative to the storyboard file"),
  at: time.optional().describe("Source time it appears. Omit both at and dur for the whole video (watermark, logo)"),
  dur: z.number().positive().optional().describe("How long it stays (s of source time); omitted with at set = until the end"),
  x: norm.describe("Left edge, 0..1 of the OUTPUT frame"),
  y: norm.describe("Top edge, 0..1 of the OUTPUT frame"),
  w: norm.refine((v) => v > 0, { message: "overlay.w must be > 0" }).describe("Width, 0..1 of the output frame"),
  h: norm.refine((v) => v > 0, { message: "overlay.h must be > 0" }).describe("Height, 0..1 of the output frame"),
  fit: z.enum(["contain", "cover"]).default("contain"),
  opacity: z.number().min(0).max(1).default(1),
  radius: z.number().min(0).optional().describe("Corner radius in output pixels"),
  shadow: z.boolean().optional(),
  motion: MotionSchema.optional().describe("Entrance and exit (default fade); words/lines/wipe fall back to fade"),
  mute: z.boolean().default(true).describe("Video only: false plays its sound too"),
  loop: z.boolean().default(false).describe("Video only: repeat until the overlay ends"),
});

export const ChapterCardSchema = z.object({
  at: time.describe("Source time the video freezes and the card shows"),
  dur: z.number().positive().default(2.5).describe("How long the card stays (s); the video is frozen meanwhile"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

export const GradeSchema = z.object({
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(0).max(2).default(1),
  saturation: z.number().min(0).max(3).default(1).describe("0 is black and white, 1 unchanged, 1.2 a little richer"),
  gamma: z.number().min(0.1).max(4).default(1).describe("Below 1 darkens the mid-tones, above 1 lifts them"),
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
  grade: GradeSchema.optional().describe("Color grade of the recording (not the cards or text); only the values you set change"),
  clickRipples: z.boolean().default(true).describe("Draw a ripple on every recorded click (needs events.jsonl)"),
  motion: z
    .object({
      captions: MotionSchema.optional().describe("Default for captions and subtitles"),
      cards: MotionSchema.optional().describe("Intro/outro title and subtitle"),
    })
    .default({}),
  fonts: z
    .array(z.string().min(1))
    .default([])
    .describe('Extra Google Fonts to load, as css2 "family" specs, e.g. "Tajawal:wght@400;700" or "Space Grotesk:wght@500;700"; then use them in font or css'),
  css: z
    .string()
    .default("")
    .describe(
      "Your own CSS, applied after the built-in styles, to design the look of this video. Elements: #root (whole frame; its background), " +
        "#frame (the recording box), .card / .card-inner / .card h1 / .card p (intro and outro), .text (captions; .text.pill, .text.subtitle, " +
        ".text.title; the visible box is .text.<style> > span; .text .ln is one line of a multi-line caption), .pos-bottom / .pos-top / .pos-center, " +
        ".hl and .hl span (highlights), .callout span, .ripple (click ripples), .ann-arrow, .ann-box, .ann-blur and .ann-label (annotations), " +
        ".keys (typing key-caps).",
    ),
});

export const VoiceSchema = z.object({
  provider: z
    .enum(["edge", "local", "command"])
    .default("edge")
    .describe("edge: Microsoft voices over the internet. local: models on this computer (name \"voicetut:Sarah\" or \"namaa\"). command: a voice you defined in voices.json (name = its key)"),
  name: z.string().default("en-US-AndrewNeural").describe("Edge voice, local model[:voice], or the key of a command voice"),
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

export const DuckSchema = z.object({
  amount: z.number().min(0).max(1).default(0.6).describe("How much quieter the music gets while someone speaks (0.6 = 60% lower)"),
  attack: z.number().min(0).max(5).default(0.2).describe("Seconds the music takes to go down, finishing as the line starts"),
  release: z.number().min(0).max(5).default(0.5).describe("Seconds the music takes to come back after the line"),
  under: z
    .array(z.enum(["narration", "overlays"]))
    .min(1)
    .optional()
    .describe('What lowers the music: "narration" (default), "overlays" (video overlays that play their own sound), or both'),
});

export const MUSIC_FADE_IN = 1;
export const MUSIC_FADE_OUT = 2;

export const MusicSchema = z.object({
  src: z.string(),
  volume: z.number().min(0).max(1).default(0.12),
  duck: DuckSchema.optional().describe("Lower the music under narration"),
  fadeIn: z.number().min(0).max(30).optional().describe("Seconds to fade in (default 1)"),
  fadeOut: z.number().min(0).max(30).optional().describe("Seconds to fade out at the end (default 2)"),
  loop: z.boolean().optional().describe("Repeat a track that is shorter than the video (default: it just ends)"),
  offset: z.number().min(0).optional().describe("Start this many seconds into the file (default 0)"),
  from: time.optional().describe("Source time the music starts (default: the start of the video, intro included)"),
  to: time.optional().describe("Source time the music ends (default: the end of the video, outro included)"),
});

export const LoudnessSchema = z.object({
  target: z.number().min(-70).max(-5).default(-16).describe("Integrated loudness in LUFS: -16 for web and social, -14 for streaming, -23 for broadcast"),
  truePeak: z.number().min(-9).max(0).default(-1.5).describe("Highest true peak in dBTP"),
});

export const AudioSchema = z.object({
  loudness: LoudnessSchema.optional().describe("Normalize the whole mix of the final video to a target loudness (use {} for -16 LUFS)"),
  denoise: z.boolean().optional().describe("Reduce steady background noise in the recording's own audio (needs keepSourceAudio)"),
});

/** Sounds ffmpeg synthesizes while rendering (see render/sfx.ts). */
export const SFX_BUILTINS = ["click", "key", "whoosh", "pop", "ding"] as const;
export const isBuiltinSfx = (name: string): name is (typeof SFX_BUILTINS)[number] => (SFX_BUILTINS as readonly string[]).includes(name);

export const SfxSchema = z.object({
  at: time.describe("Source time the sound plays"),
  src: z
    .string()
    .min(1)
    .describe('A sound file (relative to the storyboard) or a built-in: "builtin:click", "builtin:key", "builtin:whoosh", "builtin:pop", "builtin:ding"'),
  volume: z.number().min(0).max(4).default(1),
});

export const TypingSchema = z.object({
  at: time.describe("Source time the typing starts"),
  dur: z.number().positive().default(3).describe("How long the typing lasts (s)"),
  text: z.string().optional().describe("What is typed: one press per character; without it about 7 presses a second"),
  keycaps: z.boolean().optional().describe("Show the typed text on screen, word by word as it is typed (needs text)"),
});

const soundChoice = z.union([z.boolean(), z.string().min(1)]).optional();

export const SoundsSchema = z
  .object({
    clicks: soundChoice.describe('Play a sound on every recorded click (needs events): true = "builtin:click", or a built-in name / sound file'),
    typing: soundChoice.describe('Play a typing sound for every press of every typing[] span: true = "builtin:key", or a built-in name / sound file'),
    cards: soundChoice.describe('Play a sound as the intro, chapter cards and outro come in: true = "builtin:whoosh"'),
    volume: z.number().min(0).max(2).default(0.5).describe("Level of these automatic sounds (sfx[] items have their own volume)"),
  })
  .describe("Automatic sound effects from recorded events and cards");

/** Ids of the style-lint rules; every lint warning starts with `[id]`. */
export const LINT_RULES = ["narration-length", "narration-speed", "caption-length", "duration", "zoom-scale", "stack", "transition"] as const;

export const LintSchema = z
  .object({
    narrationWords: z.number().int().positive().optional().describe("Longest narration line before the narration-length warning (default 12 words)"),
    captionWords: z.number().int().positive().optional().describe("Longest caption before the caption-length warning (default 6 words)"),
    duration: z
      .object({
        min: z.number().nonnegative().optional().describe("Shortest final video (s) before the duration warning (default 15)"),
        max: z.number().positive().optional().describe("Longest final video (s) before the duration warning (default 90)"),
      })
      .optional(),
    off: z.array(z.enum(LINT_RULES)).optional().describe(`Rule ids to silence: ${LINT_RULES.join(", ")}`),
  })
  .describe("Style-lint limits for this storyboard (warnings only); long tutorials raise them or turn rules off. Inherited through extends");

/** Keys a storyboard takes from the one it `extends` (deep-merged, the child wins). */
export const INHERITED_KEYS = ["theme", "voice", "output", "music", "sounds", "audio", "keepSourceAudio", "lint"] as const;

export const StoryboardSchema = z.object({
  version: z.literal(1).default(1),
  extends: z
    .string()
    .optional()
    .describe(
      `Base storyboard to share the look with, relative to this file (it may extend another). Only ${INHERITED_KEYS.join(", ")} are inherited, ` +
        "deep-merged with this file winning; source, segments, zooms, captions and the rest are never inherited",
    ),
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
  annotations: z
    .array(AnnotationSchema)
    .default([])
    .describe("Arrows, boxes and blur/solid redaction on the recording (0..1 of the recording, so they follow zooms); use blur type solid for anything secret"),
  narration: z.array(NarrationSchema).default([]),
  intro: CardSchema.optional(),
  outro: CardSchema.optional(),
  overlays: z.array(OverlaySchema).default([]).describe("Images or videos placed on top of the output frame (logos, picture-in-picture)"),
  cards: z.array(ChapterCardSchema).default([]).describe("Chapter cards in the middle of the video; each freezes the picture for dur seconds"),
  music: MusicSchema.optional(),
  typing: z
    .array(TypingSchema)
    .default([])
    .describe("Spans where someone types in the recording: each gets typing sounds (sounds.typing). The recorder never logs keys, so you mark the spans"),
  sfx: z.array(SfxSchema).default([]).describe("Sound effects at source times (a file or a builtin:name); see also sounds for automatic ones"),
  sounds: SoundsSchema.optional(),
  audio: AudioSchema.optional(),
  lint: LintSchema.optional(),
});

export type Storyboard = z.output<typeof StoryboardSchema>;
export type StoryboardInput = z.input<typeof StoryboardSchema>;
export type Segment = z.output<typeof SegmentSchema>;
export type Hold = z.output<typeof HoldSchema>;
export type Zoom = z.output<typeof ZoomSchema>;
export type Screen = z.output<typeof ScreenSchema>;
export type View = z.output<typeof ViewSchema>;
/**
 * A style file for `render --style` / `sequence --style`: only a `theme`, every field optional.
 * It is merged over the theme of each storyboard (objects such as motion and grade key by key;
 * css, fonts and other strings and arrays are replaced). Voice, size, cuts and timings stay as the storyboard says.
 */
export const StyleSchema = z.object({ theme: ThemeSchema.partial().strict() }).strict();

export type Caption = z.output<typeof CaptionSchema>;
export type Motion = z.output<typeof MotionSchema>;
export type Narration = z.output<typeof NarrationSchema>;
export type Highlight = z.output<typeof HighlightSchema>;
export type Annotation = z.output<typeof AnnotationSchema>;
export type Overlay = z.output<typeof OverlaySchema>;
export type Sfx = z.output<typeof SfxSchema>;
export type Typing = z.output<typeof TypingSchema>;
export type Theme = z.output<typeof ThemeSchema>;

export function storyboardJsonSchema(): unknown {
  return z.toJSONSchema(StoryboardSchema, { io: "input" });
}
