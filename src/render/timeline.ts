import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { transitionOverlaps } from "../sequence/concat.js";
import type { Transition } from "../sequence/schema.js";
import type { RenderPlan } from "./plan.js";

// timeline.json: when each spoken line and each title card is on screen in the FINISHED video
// (output seconds), written next to every render and sequence render. A sequence composes the
// timelines of its parts with the same arithmetic as the join (see joinTimelines), so a caption
// file for the joined video needs no plan.json and no guessing about transitions.

/** A video and its timeline may differ by this much (s) before the timeline counts as stale. */
export const STALE_TOLERANCE = 0.25;

export const TimelineItemSchema = z.object({
  kind: z.enum(["narration", "card", "outro"]).describe("narration = a spoken line; card = intro or chapter card; outro = the closing card"),
  id: z.string().optional().describe("narration: the line's id (storyboard narration[].id, default its position)"),
  start: z.number().min(0).describe("Output seconds"),
  end: z.number().min(0),
  text: z.string().describe("The line; for a card its title, then its subtitle on a second line"),
  part: z.number().int().min(0).optional().describe("Sequences: index of the part (of the outermost sequence) the item comes from"),
  chapter: z.string().optional().describe("Sequences: folder name of the storyboard the item comes from"),
});

export const TimelineSchema = z.object({
  version: z.literal(1).default(1),
  duration: z.number().min(0).describe("Length of the video in output seconds"),
  items: z.array(TimelineItemSchema),
});

export type TimelineItem = z.output<typeof TimelineItemSchema>;
export type Timeline = z.output<typeof TimelineSchema>;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** `<video without extension>.timeline.json`, next to the video (like the .srt/.vtt files). */
export function timelinePath(videoPath: string): string {
  return `${videoPath.slice(0, videoPath.length - extname(videoPath).length)}.timeline.json`;
}

/** The narration lines and cards of a plan (already in output seconds, shifted for a `--from/--to` window), in time order. */
export function buildOutputTimeline(plan: RenderPlan, opts: { outro?: { title: string; subtitle?: string } } = {}): Timeline {
  const items: TimelineItem[] = [];
  const { outro } = opts;
  for (const c of plan.cards) {
    const isOutro = !!outro && c.title === outro.title && (c.subtitle ?? "") === (outro.subtitle ?? "") && c.start + c.dur >= plan.duration - 0.01;
    items.push({
      kind: isOutro ? "outro" : "card",
      start: c.start,
      end: round3(c.start + c.dur),
      text: c.subtitle ? `${c.title}\n${c.subtitle}` : c.title,
    });
  }
  for (const s of plan.subtitles) {
    items.push({ kind: "narration", ...(s.id !== undefined ? { id: s.id } : {}), start: s.start, end: s.end, text: s.text });
  }
  items.sort((a, b) => a.start - b.start);
  return { version: 1, duration: plan.duration, items };
}

export async function writeTimeline(file: string, timeline: Timeline): Promise<void> {
  await writeFile(file, `${JSON.stringify(timeline, null, 2)}\n`);
}

/** Read and check a timeline file; every problem names the file. */
export async function readTimeline(file: string): Promise<Timeline> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read timeline ${file}: ${(err as Error).message}`);
  }
  const r = TimelineSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`Invalid timeline ${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

/** A timeline that does not match its video (the video was rendered again, or replaced) would give cues that drift: refuse it. */
export function assertTimelineFresh(file: string, timeline: Timeline, videoDuration: number): void {
  if (Math.abs(timeline.duration - videoDuration) > STALE_TOLERANCE) {
    throw new Error(
      `Stale timeline ${file}: it says the video is ${timeline.duration.toFixed(2)}s but the video is ${videoDuration.toFixed(2)}s ` +
        `(more than ${STALE_TOLERANCE}s apart); render the video again so the timeline is rewritten`,
    );
  }
}

export interface TimelinePart {
  timeline: Timeline;
  /** Real length of the part's video (s): what the join uses, not the length the timeline claims. */
  duration: number;
  /** How the part enters from the previous one. */
  transition?: Transition;
  /** Index to give the part's items (the position in the sequence). */
  part?: number;
  /** Chapter for the part's items that have none. */
  chapter?: string;
}

/**
 * The timeline of parts joined in order. Same arithmetic as the join (concatParts):
 * a part starts where the previous one ends minus the seconds its transition overlaps
 * (its dur, at most half of either neighbour, none for a cut), so a cue lands on its audio.
 */
export function joinTimelines(parts: TimelinePart[], fps: number): Timeline {
  const overlaps = transitionOverlaps(parts, fps);
  const items: TimelineItem[] = [];
  let length = 0;
  for (const [i, p] of parts.entries()) {
    const start = length - overlaps[i]!;
    for (const it of p.timeline.items) {
      items.push({
        ...it,
        start: round3(it.start + start),
        end: round3(it.end + start),
        part: p.part ?? i,
        ...(it.chapter === undefined && p.chapter !== undefined ? { chapter: p.chapter } : {}),
      });
    }
    length = start + p.duration;
  }
  items.sort((a, b) => a.start - b.start);
  return { version: 1, duration: round3(length), items };
}
