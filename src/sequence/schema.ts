import { z } from "zod";

// A sequence joins several parts into one video, in order: storyboards (each with
// its own recording), other sequences, or finished videos. Paths are relative to
// the sequence file.

export const TRANSITIONS = ["cut", "crossfade", "fade-black", "wipe-left", "wipe-right", "slide-left", "slide-right"] as const;

export const TransitionSchema = z
  .object({
    type: z.enum(TRANSITIONS),
    dur: z.number().positive().default(0.5).describe("Seconds the two parts overlap; at most half of either part"),
  })
  .describe("How this part enters from the previous one (ignored on the first part). Default: cut");

export const PartSchema = z
  .object({
    storyboard: z.string().min(1).optional().describe("Path to a storyboard.json, relative to the sequence file"),
    sequence: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to another sequence.json, relative to this file: it is rendered on its own (and reused until one of its parts changes), " +
          "then joined like any part. from/to are not allowed. A sequence that includes itself, directly or not, is an error",
      ),
    video: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a finished video (mp4), relative to this file, used as is; it is scaled to the sequence's size and frame rate if it differs. " +
          "from/to are seconds of that video",
      ),
    transition: TransitionSchema.optional(),
    from: z.number().min(0).optional().describe("Second this part starts at (default: the start). Source seconds of a storyboard, or seconds of a video"),
    to: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Second this part ends at (default: the end). The same storyboard can appear twice: {to: 42} then {from: 42} " +
          "splits it at source second 42, e.g. to insert another part there",
      ),
  })
  .describe("Exactly one of storyboard, sequence or video")
  .superRefine((p, ctx) => {
    const kinds = (["storyboard", "sequence", "video"] as const).filter((k) => p[k] !== undefined);
    if (kinds.length !== 1) ctx.addIssue({ code: "custom", message: "a part needs exactly one of storyboard, sequence or video" });
    if (p.sequence !== undefined && (p.from !== undefined || p.to !== undefined))
      ctx.addIssue({ code: "custom", message: "from/to are not allowed on a nested sequence; trim its own parts instead" });
    if (p.from !== undefined && p.to !== undefined && p.to <= p.from) ctx.addIssue({ code: "custom", message: "to must be greater than from" });
  });

export const SequenceSchema = z.object({
  version: z.literal(1).default(1),
  output: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().int().min(1).max(120).optional(),
    })
    .optional()
    .describe("Size and frame rate of every part (default: the first part's output); fields given here override it"),
  parts: z
    .array(PartSchema)
    .min(1)
    .describe(
      "Parts in playing order: storyboards, nested sequences or finished videos. The intro card plays only on the first part and the outro only on the last",
    ),
});

export type Sequence = z.output<typeof SequenceSchema>;
export type Part = z.output<typeof PartSchema>;
export type Transition = z.output<typeof TransitionSchema>;

export function sequenceJsonSchema(): unknown {
  return z.toJSONSchema(SequenceSchema, { io: "input" });
}
