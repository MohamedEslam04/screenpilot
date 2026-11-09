import { run } from "../util/exec.js";
import { probeVideo } from "../util/media.js";
import { parseSilences } from "../voice/split.js";
import type { Timeline } from "./timeline.js";

// Do the caption times land on the audio? For each narration line of a timeline, find the first sound at
// or after its start (ffmpeg silencedetect over the finished video) and warn when it is far from the start.

/** A line whose sound starts later than this after its cue is reported (seconds). */
export const SYNC_TOLERANCE = 0.4;

export interface SyncOffset {
  id?: string;
  text: string;
  start: number;
  /** Seconds from the cue start to the first sound; null when there is no sound after it. */
  offset: number | null;
}

export interface SyncResult {
  /** Narration lines compared. 0 when the video has no sound or the timeline has no narration. */
  checked: number;
  offsets: SyncOffset[];
  warnings: string[];
}

const EDGE = 0.1;

/** The offset of one cue, given the silent spans of the audio: 0 while it is already sounding, else the wait for the next sound. */
export function soundOffset(start: number, silences: { start: number; end: number }[], duration: number): number | null {
  // silencedetect marks a silence a few tens of ms after the sound really stopped, so a cue that starts right at the end of a sound is in the silence.
  const gap = silences.find((s) => s.start - EDGE <= start && start < s.end);
  if (!gap) return 0;
  return gap.end >= duration - 0.05 ? null : Math.max(0, gap.end - start);
}

export async function checkSubtitleSync(video: string, timeline: Timeline, opts: { noiseDb?: number; minSilence?: number; tolerance?: number } = {}): Promise<SyncResult> {
  const narration = timeline.items.filter((i) => i.kind === "narration");
  const info = await probeVideo(video);
  if (!info.hasAudio || !narration.length) return { checked: 0, offsets: [], warnings: [] };
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-vn", "-af", `silencedetect=noise=${opts.noiseDb ?? -35}dB:d=${opts.minSilence ?? 0.2}`, "-f", "null", "-"]);
  const silences = parseSilences(stderr, info.duration);
  const tolerance = opts.tolerance ?? SYNC_TOLERANCE;
  const offsets: SyncOffset[] = narration.map((n) => ({ ...(n.id !== undefined ? { id: n.id } : {}), text: n.text, start: n.start, offset: soundOffset(n.start, silences, info.duration) }));
  const warnings = offsets.flatMap((o) => {
    const label = `"${o.text.length > 40 ? `${o.text.slice(0, 40)}...` : o.text}" at ${o.start.toFixed(2)}s`;
    if (o.offset === null) return [`subtitle sync: no sound after the cue ${label}`];
    return o.offset > tolerance ? [`subtitle sync: the sound for ${label} starts ${o.offset.toFixed(2)}s later (more than ${tolerance}s)`] : [];
  });
  return { checked: narration.length, offsets, warnings };
}
