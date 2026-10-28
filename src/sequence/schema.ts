import { z } from "zod";

// A sequence joins several storyboards (each with its own recording) into one
// video, in order. Paths are relative to the sequence file.

export const TRANSITIONS = ["cut", "crossfade", "fade-black", "wipe-left", "wipe-right", "slide-left", "slide-right"] as const;

export const TransitionSchema = z
  .object({
    type: z.enum(TRANSITIONS),
    dur: z.number().positive().default(0.5).describe("Seconds the two parts overlap; at most half of either part"),
  })
  .describe("How this part enters from the previous one (ignored on the first part). Default: cut");

export const PartSchema = z
  .object({
    storyboard: z.string().min(1).describe("Path to a storyboard.json, relative to the sequence file"),
    transition: TransitionSchema.optional(),
    from: z.number().min(0).optional().describe("Source second this part starts at (default: the start)"),
    to: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Source second this part ends at (default: the end). The same storyboard can appear twice: {to: 42} then {from: 42} " +
          "splits it at source second 42, e.g. to insert another part there",
      ),
  })
  .refine((p) => p.from === undefined || p.to === undefined || p.to > p.from, { message: "to must be greater than from" });

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
    .describe("Storyboards in playing order. The intro card plays only on the first part and the outro only on the last"),
});

export type Sequence = z.output<typeof SequenceSchema>;
export type Part = z.output<typeof PartSchema>;
export type Transition = z.output<typeof TransitionSchema>;

export function sequenceJsonSchema(): unknown {
  return z.toJSONSchema(SequenceSchema, { io: "input" });
}
