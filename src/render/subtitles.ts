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

// Cue rules: what a caption file needs to read well on a platform player. Only the per-language
// files use them (render --subtitle-lang, sequence, subs); `render --subtitles` keeps its cues as they are.

export interface CueRules {
  /** Lines in one cue. */
  maxLines: number;
  /** Characters (code points) in one line; a word longer than this stays whole. */
  maxChars: number;
  /** Shortest a cue may be (s), as far as the next cue leaves room. */
  minDuration: number;
}

export const DEFAULT_CUE_RULES: CueRules = { maxLines: 2, maxChars: 42, minDuration: 0.7 };

const len = (s: string) => [...s].length;

/** Greedy wrap on spaces. No word is ever cut, and nothing is added to or removed from the words (no bidi marks, no reordering). */
function wrapGreedy(words: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (len(line) + 1 + len(w) <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The fewest lines that fit, then as even as possible (so a 2-line cue is not one long and one short line). */
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/[ \t]+/).filter(Boolean);
  const lines = wrapGreedy(words, maxChars);
  if (lines.length < 2) return lines;
  // Narrowest width that still gives the same number of lines.
  const longest = Math.max(...words.map(len));
  for (let w = Math.max(Math.ceil(len(words.join(" ")) / lines.length), longest); w < maxChars; w++) {
    const even = wrapGreedy(words, w);
    if (even.length === lines.length) return even;
  }
  return lines;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Cues that follow the rules: at most `maxLines` lines of about `maxChars` characters (a longer text becomes
 * several cues that share the time of the original in proportion to their length), no cue runs into the next
 * one, and none is shorter than `minDuration` when the next cue leaves room.
 */
export function shapeCues(cues: SubtitleCue[], rules: Partial<CueRules> = {}): SubtitleCue[] {
  const { maxLines, maxChars, minDuration } = { ...DEFAULT_CUE_RULES, ...rules };
  if (!(maxLines >= 1) || !(maxChars >= 1)) throw new Error("subtitle rules need at least 1 line and 1 character per line");
  const sorted = clean(cues);
  const out: SubtitleCue[] = [];
  for (const [i, c] of sorted.entries()) {
    const next = sorted[i + 1]?.start ?? Infinity;
    const room = Math.max(next - c.start, MIN_CUE);
    // At least minDuration, at most what the next cue leaves; never longer than what the line was given, unless it was too short.
    const span = Math.min(Math.max(c.end - c.start, minDuration), room);
    const lines = c.text.split("\n").flatMap((l) => wrapText(l, maxChars));
    const pages: string[][] = [];
    for (let k = 0; k < lines.length; k += maxLines) pages.push(lines.slice(k, k + maxLines));
    const weights = pages.map((p) => Math.max(1, len(p.join(" "))));
    const total = weights.reduce((a, b) => a + b, 0);
    const spare = span - pages.length * minDuration;
    const durations = weights.map((w) => (spare >= 0 ? minDuration + (spare * w) / total : (span * w) / total));
    let t = c.start;
    for (const [k, p] of pages.entries()) {
      const end = k === pages.length - 1 ? c.start + span : t + durations[k]!;
      out.push({ start: round3(t), end: round3(end), text: p.join("\n") });
      t = end;
    }
  }
  return out;
}
