import { extname } from "node:path";
import { run } from "../util/exec.js";

// Caption files added to a finished video as soft tracks (the viewer picks the language in the player).
// The picture and sound are copied, never re-encoded, and the original file is left alone.

export interface SubtitleTrack {
  /** The caption file (.srt or .vtt). */
  file: string;
  /** Language code the file was made for (`ar`, `en`, `pt-BR`); none for a plain file. */
  language?: string;
}

// ISO 639-1 -> ISO 639-2, the three-letter tag the MP4 and Matroska muxers want in the language field.
const ISO639_2: Record<string, string> = {
  ar: "ara", bg: "bul", bn: "ben", ca: "cat", cs: "ces", da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", fa: "fas", fi: "fin",
  fr: "fra", he: "heb", hi: "hin", hr: "hrv", hu: "hun", id: "ind", it: "ita", ja: "jpn", ko: "kor", ms: "msa", nb: "nob", nl: "nld",
  no: "nor", pl: "pol", pt: "por", ro: "ron", ru: "rus", sk: "slk", sv: "swe", sw: "swa", th: "tha", tr: "tur", uk: "ukr", ur: "urd",
  vi: "vie", zh: "zho",
};

/** `ar` -> `ara`, `en-US` -> `eng`; a three-letter code (or one we do not know) is kept as it is. */
export function subtitleLanguageTag(code: string): string {
  const base = code.split(/[-_]/)[0]!.toLowerCase();
  return ISO639_2[base] ?? base;
}

/** `<video without extension>.subs<extension>`. */
export function subsPath(video: string): string {
  const ext = extname(video);
  return `${video.slice(0, video.length - ext.length)}.subs${ext}`;
}

/** mov_text for MP4/MOV, WebVTT for Matroska and WebM; any other container is an error. */
export function subtitleCodecFor(video: string): "mov_text" | "webvtt" {
  const ext = extname(video).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v" || ext === ".mov") return "mov_text";
  if (ext === ".mkv" || ext === ".webm") return "webvtt";
  throw new Error(`Cannot add subtitle tracks to a ${ext || "file without an extension"} video (use .mp4, .mov, .mkv or .webm)`);
}

export function buildMuxArgs(video: string, tracks: SubtitleTrack[], output: string): string[] {
  const codec = subtitleCodecFor(output);
  const args = ["-y", "-loglevel", "error", "-i", video];
  for (const t of tracks) args.push("-i", t.file);
  // Video and audio of the original; any caption track it already had is not carried over (it would shift the track numbers).
  args.push("-map", "0:v", "-map", "0:a?");
  tracks.forEach((_, i) => args.push("-map", String(i + 1)));
  args.push("-c", "copy", "-c:s", codec);
  tracks.forEach((t, i) => {
    if (t.language) args.push(`-metadata:s:s:${i}`, `language=${subtitleLanguageTag(t.language)}`, `-metadata:s:s:${i}`, `title=${t.language}`);
  });
  if (codec === "mov_text") args.push("-movflags", "+faststart");
  args.push(output);
  return args;
}

/** Write `<video>.subs.<ext>` with the tracks added; returns its path. */
export async function muxSubtitles(video: string, tracks: SubtitleTrack[], output = subsPath(video)): Promise<string> {
  if (!tracks.length) throw new Error("No subtitle files to add");
  if (output === video) throw new Error("The output would overwrite the original video");
  await run("ffmpeg", buildMuxArgs(video, tracks, output));
  return output;
}
