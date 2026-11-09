import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { type CueRules, shapeCues, type SubtitleCue, type SubtitleFormat, writeSubtitles } from "./subtitles.js";
import type { Timeline } from "./timeline.js";

// One caption file per language from a timeline.json (see timeline.ts): the video's own lines, or lines
// the user (or an agent) translated into a JSON file. Nothing here calls a translation service.

export interface SubtitleLanguage {
  /** File-name part and track language: `<video>.<code>.srt`. */
  code: string;
  /** Translation file. Without it the language uses the video's own lines. */
  file?: string;
}

/** A language tag that is safe in a file name: `ar`, `en`, `pt-BR`, `zh_Hans`. */
const CODE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

/**
 * `ar,en=en.json,es=es.json` (CLI) or `{ ar: "auto", en: "en.json" }` (MCP: "auto" = the video's own lines).
 * Translation files are resolved from the current folder.
 */
export function parseSubtitleLanguages(value: string | string[] | Record<string, string> | undefined): SubtitleLanguage[] {
  if (value === undefined) return [];
  const entries: [string, string | undefined][] = Array.isArray(value) || typeof value === "string"
    ? (Array.isArray(value) ? value : value.split(",")).map((e) => e.trim()).filter(Boolean).map((e) => {
        const eq = e.indexOf("=");
        return eq < 0 ? ([e, undefined] as [string, string | undefined]) : ([e.slice(0, eq).trim(), e.slice(eq + 1).trim() || undefined] as [string, string | undefined]);
      })
    : Object.entries(value).map(([code, file]) => [code, file === "auto" || !file ? undefined : file] as [string, string | undefined]);
  const out: SubtitleLanguage[] = [];
  for (const [code, file] of entries) {
    if (!CODE.test(code)) throw new Error(`"${code}" is not a language code (use ar, en, pt-BR ...; a translation file goes after =, e.g. en=en.json)`);
    if (out.some((l) => l.code === code)) throw new Error(`language "${code}" is listed twice`);
    out.push({ code, ...(file ? { file: resolve(file) } : {}) });
  }
  return out;
}

// { "<id or index>": "line" } for a single video, { "<chapter>": ["line", ...] | { "<id or index>": "line" } } for a sequence; both may be mixed.
const TranslationSchema = z.record(z.string(), z.union([z.string(), z.array(z.string()), z.record(z.string(), z.string())]));
export type Translation = z.output<typeof TranslationSchema>;

export async function loadTranslation(file: string): Promise<Translation> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read translation ${file}: ${(err as Error).message}`);
  }
  const r = TranslationSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`Invalid translation ${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}. Use { "<id or index>": "line" } or { "<chapter>": ["line", ...] }`);
  }
  return r.data;
}

/** Read and check every translation file now, so a missing or broken one fails before a long render, not after it. */
export async function checkTranslations(languages: SubtitleLanguage[] | undefined): Promise<void> {
  for (const l of languages ?? []) if (l.file) await loadTranslation(l.file);
}

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

/**
 * The narration of a timeline as cues, with the lines of a translation when one is given.
 * A line is found by its id (else its position in its chapter, 0-based) in the chapter's entry, then in the top level.
 * A chapter given as an array must have exactly one line per narration line of that chapter; a line without a
 * translation fails naming it. Keys that match nothing only warn (a --from/--to window has fewer lines).
 */
export function cuesForLanguage(timeline: Timeline, translation?: Translation, file = "translation"): { cues: SubtitleCue[]; warnings: string[] } {
  const narration = timeline.items.filter((i) => i.kind === "narration");
  if (!translation) return { cues: narration.map((i) => ({ start: i.start, end: i.end, text: i.text })), warnings: [] };

  const perChapter = new Map<string, number>();
  const keyed = narration.map((it) => {
    const chapter = it.chapter ?? "";
    const pos = perChapter.get(chapter) ?? 0;
    perChapter.set(chapter, pos + 1);
    return { it, pos, key: it.id ?? String(pos) };
  });

  for (const [chapter, count] of perChapter) {
    const entry = chapter ? translation[chapter] : undefined;
    if (Array.isArray(entry) && entry.length !== count) {
      throw new Error(`Translation ${file}: chapter "${chapter}" has ${plural(entry.length)} but the video has ${count}`);
    }
  }

  const used = new Set<string>();
  const cues: SubtitleCue[] = keyed.map(({ it, pos, key }) => {
    const chapter = it.chapter;
    const entry = chapter !== undefined ? translation[chapter] : undefined;
    let text: string | undefined;
    if (Array.isArray(entry)) {
      text = entry[pos];
      used.add(chapter!);
    } else if (entry !== undefined && typeof entry === "object") {
      text = entry[key];
      used.add(chapter!);
    } else if (typeof translation[key] === "string") {
      text = translation[key] as string;
      used.add(key);
    }
    if (text === undefined) {
      throw new Error(`Translation ${file} has no line for ${chapter !== undefined ? `chapter "${chapter}", ` : ""}id "${key}" (${it.start.toFixed(2)}s: "${it.text.slice(0, 40)}")`);
    }
    return { start: it.start, end: it.end, text };
  });
  const warnings = Object.keys(translation).filter((k) => !used.has(k)).map((k) => `Translation ${file}: "${k}" matches no narration line and was ignored`);
  return { cues, warnings };
}

export interface TimelineSubtitleOptions {
  /** Empty: one plain `<video>.srt`, from the video's own lines. */
  languages: SubtitleLanguage[];
  formats: SubtitleFormat[];
  rules?: Partial<CueRules>;
}

/** `<video>.<code>.srt|vtt` for every language (or `<video>.srt|vtt` without languages), cue rules applied. */
export async function writeTimelineSubtitles(timeline: Timeline, videoPath: string, opts: TimelineSubtitleOptions): Promise<{ files: string[]; warnings: string[] }> {
  const files: string[] = [];
  const warnings: string[] = [];
  const targets: SubtitleLanguage[] = opts.languages.length ? opts.languages : [{ code: "" }];
  // Read every translation before writing anything: a bad file must not leave half the files.
  const prepared = await Promise.all(
    targets.map(async (l) => {
      const translation = l.file ? await loadTranslation(l.file) : undefined;
      const r = cuesForLanguage(timeline, translation, l.file ?? "");
      return { code: l.code, cues: shapeCues(r.cues, opts.rules), warnings: r.warnings };
    }),
  );
  for (const p of prepared) {
    warnings.push(...p.warnings);
    const target = p.code ? withCode(videoPath, p.code) : videoPath;
    files.push(...(await writeSubtitles(p.cues, target, opts.formats)));
  }
  return { files, warnings };
}

/** `demo.mp4` + `es` -> `demo.es.mp4` (the extension only locates the name; writeSubtitles replaces it). */
function withCode(videoPath: string, code: string): string {
  const dot = videoPath.lastIndexOf(".");
  const slash = Math.max(videoPath.lastIndexOf("/"), videoPath.lastIndexOf("\\"));
  const base = dot > slash ? videoPath.slice(0, dot) : videoPath;
  return `${base}.${code}.x`;
}
