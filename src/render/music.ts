import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MUSIC_FADE_IN, MUSIC_FADE_OUT, type Storyboard } from "../storyboard/schema.js";
import type { Timeline } from "../storyboard/timeline.js";
import { run } from "../util/exec.js";
import { ffmpegFilterScriptFlag, probeDuration } from "../util/media.js";

// Background music. A track that plays from the start to the end of the video, with the
// default fades, goes straight into the composition. Looping, an offset or a from/to range
// pre-render the track with ffmpeg first (music-track.wav), fades included.

type Music = NonNullable<Storyboard["music"]>;

const SAMPLE_RATE = 48000;

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface MusicRange {
  /** Output seconds. */
  start: number;
  end: number;
  /** Uses loop, offset, from or to, so the track has to be prepared. */
  custom: boolean;
  warnings: string[];
}

/** Where the music plays in the output: from/to (source seconds) mapped through the cuts. */
export function planMusicRange(music: Music, tl: Timeline, duration: number): MusicRange {
  const warnings: string[] = [];
  const custom = !!music.loop || (music.offset ?? 0) > 0 || music.from !== undefined || music.to !== undefined;
  let start = 0;
  let end = duration;
  if (music.from !== undefined) {
    const t = tl.toOutput(music.from);
    if (t === null) warnings.push(`music.from ${music.from}s falls in a cut region; the music starts at the beginning instead`);
    else start = t;
  }
  if (music.to !== undefined) {
    const t = tl.toOutput(music.to);
    if (t === null) warnings.push(`music.to ${music.to}s falls in a cut region; the music plays to the end instead`);
    else end = Math.min(t, duration);
  }
  if (end - start < 0.05) {
    warnings.push("music.from and music.to leave no time for the music; the whole video is used instead");
    start = 0;
    end = duration;
  }
  return { start: round(start), end: round(end), custom, warnings };
}

export interface MusicFilterOptions {
  /** Seconds into the file. */
  offset: number;
  loop: boolean;
  /** Seconds the music should last. */
  length: number;
  fadeIn: number;
  fadeOut: number;
  /** Length of the file. */
  trackDuration: number;
}

/** Filter graph for the prepared track, and how long it really is (0 = nothing to play). */
export function buildMusicFilter(o: MusicFilterOptions): { filter: string; length: number } {
  const available = Math.max(0, o.trackDuration - o.offset);
  const length = round(o.loop ? (available > 0 ? o.length : 0) : Math.min(o.length, available));
  if (length <= 0) return { filter: "", length: 0 };
  const fadeIn = round(Math.min(o.fadeIn, length / 2));
  const fadeOut = round(Math.min(o.fadeOut, length / 2));
  const chain = [`atrim=start=${round(o.offset)}`, "asetpts=PTS-STARTPTS"];
  if (o.loop) chain.push("aloop=loop=-1:size=2147483647");
  chain.push(`atrim=end=${length}`, "asetpts=PTS-STARTPTS");
  if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) chain.push(`afade=t=out:st=${round(length - fadeOut)}:d=${fadeOut}`);
  chain.push(`aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`);
  return { filter: `[0:a]${chain.join(",")}[out]`, length };
}

export interface PreparedMusic {
  /** File name inside the build dir, undefined when there is nothing to play. */
  file?: string;
  /** Seconds the prepared track lasts. */
  length: number;
  warnings: string[];
}

/** Render the music track for a custom range into `<buildDir>/music-track.wav` (cached). */
export async function prepareMusic(
  music: Music,
  source: string,
  range: MusicRange,
  opts: { buildDir: string; log?: (m: string) => void },
): Promise<PreparedMusic> {
  const trackDuration = await probeDuration(source);
  const { filter, length } = buildMusicFilter({
    offset: music.offset ?? 0,
    loop: !!music.loop,
    length: range.end - range.start,
    fadeIn: music.fadeIn ?? MUSIC_FADE_IN,
    fadeOut: music.fadeOut ?? MUSIC_FADE_OUT,
    trackDuration,
  });
  if (length <= 0) return { length: 0, warnings: [`music.offset ${music.offset}s is past the end of the music file (${round(trackDuration)}s); no music was added`] };

  const st = await stat(source);
  const key = createHash("sha1").update(`${source}|${st.size}|${st.mtimeMs}|${filter}`).digest("hex");
  const out = join(opts.buildDir, "music-track.wav");
  const keyFile = join(opts.buildDir, "music-track.key");
  if (existsSync(out) && existsSync(keyFile) && (await readFile(keyFile, "utf8")) === key) {
    opts.log?.("music: unchanged, reusing music-track.wav");
    return { file: "music-track.wav", length, warnings: [] };
  }
  opts.log?.(`music: preparing ${length.toFixed(1)}s${music.loop ? " (looped)" : ""}`);
  const script = join(opts.buildDir, "music.filter");
  await writeFile(script, filter);
  await rm(keyFile, { force: true }); // an aborted run leaves a half-written file
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", source, await ffmpegFilterScriptFlag(), script, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", "2", out]);
  await writeFile(keyFile, key);
  return { file: "music-track.wav", length, warnings: [] };
}
