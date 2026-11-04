import { writeFile } from "node:fs/promises";
import { extname } from "node:path";

// Subtitle files (SRT, WebVTT) from the narration lines. They are written next to the
// video, so a platform that takes a caption file (YouTube, LinkedIn, Vimeo) gets the same
// words as the burned-in subtitles, in the same times, even when those are turned off.

export interface SubtitleCue {
  /** Output seconds. */
  start: number;
  end: number;
  text: string;
}

export type SubtitleFormat = "srt" | "vtt";

const MIN_CUE = 0.04;

export function parseSubtitleFormats(value: string | string[] | undefined): SubtitleFormat[] {
  if (value === undefined) return [];
  const list = (Array.isArray(value) ? value : value.split(",")).map((f) => f.trim().toLowerCase()).filter(Boolean);
  const out: SubtitleFormat[] = [];
  for (const f of list) {
    if (f !== "srt" && f !== "vtt") throw new Error(`unknown subtitle format "${f}" (use srt, vtt or srt,vtt)`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

function stamp(t: number, sep: "," | "."): string {
  const ms = Math.round(Math.max(0, t) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

/** Cues in time order, with blank text dropped and no blank lines inside a cue (they would end it). */
function clean(cues: SubtitleCue[]): SubtitleCue[] {
  return cues
    .map((c) => ({ start: c.start, end: Math.max(c.end, c.start + MIN_CUE), text: c.text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n") }))
    .filter((c) => c.text)
    .sort((a, b) => a.start - b.start);
}

export function toSrt(cues: SubtitleCue[]): string {
  const body = clean(cues).map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}`);
  return body.length ? `${body.join("\n\n")}\n` : "";
}

const vttText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toVtt(cues: SubtitleCue[]): string {
  const body = clean(cues).map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${vttText(c.text)}`);
  return body.length ? `WEBVTT\n\n${body.join("\n\n")}\n` : "WEBVTT\n";
}

/** Write `<video without extension>.srt` / `.vtt`; returns the paths. */
export async function writeSubtitles(cues: SubtitleCue[], videoPath: string, formats: SubtitleFormat[]): Promise<string[]> {
  const base = videoPath.slice(0, videoPath.length - extname(videoPath).length);
  const files: string[] = [];
  for (const f of formats) {
    const file = `${base}.${f}`;
    await writeFile(file, f === "srt" ? toSrt(cues) : toVtt(cues));
    files.push(file);
  }
  return files;
}
