import { existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { type Transition, TRANSITIONS } from "../sequence/schema.js";
import { probeVideo } from "../util/media.js";
import { type SubtitleTrack } from "./mux-subs.js";
import { checkTranslations, type SubtitleLanguage, writeTimelineSubtitles } from "./subtitle-langs.js";
import type { CueRules, SubtitleFormat } from "./subtitles.js";
import { assertTimelineFresh, joinTimelines, readTimeline, type Timeline, timelinePath, type TimelinePart } from "./timeline.js";

// `screenpilot subs <video>`: caption files (and optionally soft tracks) for a video that is already rendered,
// from its timeline.json, without rendering anything again.

export interface SubsOptions {
  /** Empty: one plain `<video>.srt|vtt`. */
  languages: SubtitleLanguage[];
  /** Default srt and vtt. */
  formats?: SubtitleFormat[];
  rules?: Partial<CueRules>;
  /** Timelines (of the parts, in order) of a video that was joined outside ScreenPilot, e.g. by a shell script; replaces `<video>.timeline.json`. */
  join?: string[];
  /** Seconds each part after the first overlaps the one before it (the transition used when the video was joined). Default 0: plain cuts. */
  transition?: number;
  /** How the parts were blended (default crossfade; the overlap is the same for every type but `cut`). */
  transitionType?: Transition["type"];
}

export interface SubsResult {
  files: string[];
  /** The timeline the cues came from. */
  timeline: string;
  duration: number;
  warnings: string[];
  /** One caption file per language, ready for muxSubtitles (srt when written, else vtt). */
  tracks: SubtitleTrack[];
}

export function parseTransitionType(value: string): Transition["type"] {
  const t = TRANSITIONS.find((x) => x === value);
  if (!t) throw new Error(`unknown transition type "${value}" (use ${TRANSITIONS.join(", ")})`);
  return t;
}

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".mov", ".m4v"];

/** The video a part timeline belongs to (`a.timeline.json` -> `a.mp4`), when it is next to it. */
function videoNextTo(timelineFile: string): string | undefined {
  const base = timelineFile.replace(/\.timeline\.json$/, "");
  if (base === timelineFile) return undefined;
  return VIDEO_EXTENSIONS.map((e) => `${base}${e}`).find((f) => existsSync(f));
}

export async function makeSubtitles(video: string, opts: SubsOptions): Promise<SubsResult> {
  if (!existsSync(video)) throw new Error(`Video not found: ${video}`);
  await checkTranslations(opts.languages);
  const info = await probeVideo(video);
  let timeline: Timeline;
  let timelineName: string;
  if (opts.join?.length) {
    timelineName = opts.join.join(", ");
    const parts: TimelinePart[] = [];
    for (const [i, file] of opts.join.entries()) {
      const tl = await readTimeline(file);
      // A part's own video, when it sits next to its timeline, is the real length; a part that was changed after its timeline was written is refused.
      const partVideo = videoNextTo(file);
      const duration = partVideo ? (await probeVideo(partVideo)).duration : tl.duration;
      if (partVideo) assertTimelineFresh(file, tl, duration);
      const transition: Transition | undefined = i > 0 && opts.transition ? { type: opts.transitionType ?? "crossfade", dur: opts.transition } : undefined;
      parts.push({ timeline: tl, duration, transition, part: i, chapter: basename(file).replace(/\.timeline\.json$/, "") });
    }
    timeline = joinTimelines(parts, Math.round(info.fps));
  } else {
    timelineName = timelinePath(video);
    if (!existsSync(timelineName)) {
      throw new Error(`No timeline next to ${video}: expected ${timelineName}. Render the video with ScreenPilot again, or for a video joined from other videos pass --join a.timeline.json,b.timeline.json (and --transition <seconds>)`);
    }
    timeline = await readTimeline(timelineName);
  }
  assertTimelineFresh(timelineName, timeline, info.duration);

  const formats = opts.formats?.length ? opts.formats : (["srt", "vtt"] as SubtitleFormat[]);
  const r = await writeTimelineSubtitles(timeline, video, { languages: opts.languages, formats, rules: opts.rules });
  const tracks: SubtitleTrack[] = (opts.languages.length ? opts.languages.map((l) => l.code) : [""]).map((code) => {
    const files = r.files.filter((f) => (code ? f.endsWith(`.${code}${extname(f)}`) : true));
    return { file: files.find((f) => f.endsWith(".srt")) ?? files[0]!, ...(code ? { language: code } : {}) };
  });
  return { files: r.files, timeline: timelineName, duration: info.duration, warnings: r.warnings, tracks };
}
