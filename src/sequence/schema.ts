import { z } from "zod";

// A sequence joins several storyboards (each with its own recording) into one
// video, in order. Paths are relative to the sequence file.

export const PartSchema = z.object({
  storyboard: z.string().min(1).describe("Path to a storyboard.json, relative to the sequence file"),
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
    .describe("Storyboards in playing order. The intro card plays only on the first part and the outro only on the last"),
});

export type Sequence = z.output<typeof SequenceSchema>;
export type Part = z.output<typeof PartSchema>;

export function sequenceJsonSchema(): unknown {
  return z.toJSONSchema(SequenceSchema, { io: "input" });
}
