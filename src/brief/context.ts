import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "../brand.js";
import type { Answers, Suggested } from "./questions.js";

// What the questions recommend: the choices an existing video was made with
// (so a re-made video keeps its voice, language and size), then the choices
// the user made last time. Nothing here asks anything or changes anything.

export interface ProjectHint {
  /** The storyboard this was read from. */
  file: string;
  /** One line for the user, e.g. "12 narration lines, voice files already attached". */
  summary: string;
  answers: Answers;
  /** What the video shows, as far as the storyboard says. */
  content?: string;
}

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

function languageOf(voiceName: string, lines: string[]): string | undefined {
  if (/^ar-EG/i.test(voiceName)) return "ar-EG";
  if (/^ar-/i.test(voiceName)) return "ar";
  if (/^en-/i.test(voiceName)) return "en";
  if (lines.some((l) => count(l, ARABIC) > 0 && count(l, LATIN) >= 3)) return "bilingual";
  const text = lines.join(" ");
  const ar = count(text, ARABIC);
  const lat = count(text, LATIN);
  if (ar + lat === 0) return undefined;
  return ar > lat ? "ar-EG" : "en";
}

/** The choices a storyboard was made with, as answers to the brief. Tolerant: a field it does not understand is skipped. */
function fromStoryboard(file: string, sb: Record<string, unknown>): ProjectHint {
  const answers: Answers = {};
  const narration = (Array.isArray(sb.narration) ? sb.narration : []).filter((n): n is Record<string, unknown> => !!n && typeof n === "object");
  const lines = narration.map((n) => (typeof n.text === "string" ? n.text : "")).filter(Boolean);
  const withAudio = narration.filter((n) => typeof n.audio === "string" && n.audio).length;
  const voice = (sb.voice && typeof sb.voice === "object" ? sb.voice : {}) as { provider?: unknown; name?: unknown };
  const provider = typeof voice.provider === "string" ? voice.provider : "edge";
  const voiceName = typeof voice.name === "string" ? voice.name : "";

  if (typeof sb.source === "string" && sb.source) answers.source = "existing";

  if (withAudio > 0) {
    // Ready-made voice files (e.g. made on a website) are already attached: keep them.
    answers.voice_source = "external";
    answers.voice_external = "other";
  } else if (provider === "local") {
    answers.voice_source = "builtin";
    answers.voice_builtin = "local";
  } else if (provider === "command") {
    answers.voice_source = "own";
    answers.voice_own = "command";
  } else if (lines.length > 0) {
    answers.voice_source = "builtin";
    answers.voice_builtin = "edge";
  }

  const language = languageOf(voiceName, lines);
  if (language) answers.language = language;

  const out = (sb.output && typeof sb.output === "object" ? sb.output : {}) as { width?: unknown; height?: unknown };
  const w = Number(out.width);
  const h = Number(out.height);
  if (w > 0 && h > 0) answers.goal = h > w * 1.5 ? "social-vertical" : Math.abs(w - h) <= 10 ? "social-square" : "youtube";

  const first = lines[0]?.replace(/\s+/g, " ").slice(0, 90);
  const bits = [`${lines.length} narration line${lines.length === 1 ? "" : "s"}`];
  if (withAudio > 0) bits.push("voice files already attached");
  return {
    file,
    summary: bits.join(", "),
    answers,
    ...(first ? { content: `Update the existing video (${bits[0]}), it starts: "${first}"` } : {}),
  };
}

const isStoryboardName = (n: string) => /^storyboard\.json$/i.test(n) || /\.storyboard\.json$/i.test(n);

async function newest(paths: string[]): Promise<string | undefined> {
  const dated = await Promise.all(paths.map(async (p) => ({ p, t: (await stat(p).catch(() => undefined))?.mtimeMs ?? 0 })));
  return dated.sort((a, b) => b.t - a.t)[0]?.p;
}

async function findStoryboard(path: string): Promise<string | undefined> {
  const st = await stat(path).catch(() => undefined);
  if (!st) return undefined;
  if (st.isFile()) return path;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const here = await newest(entries.filter((e) => e.isFile() && isStoryboardName(e.name)).map((e) => join(path, e.name)));
  if (here) return here;
  // A session folder from `record` holds its own storyboard.json one level down.
  const below: string[] = [];
  for (const d of entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")) {
    const sub = await readdir(join(path, d.name), { withFileTypes: true }).catch(() => []);
    below.push(...sub.filter((e) => e.isFile() && isStoryboardName(e.name)).map((e) => join(path, d.name, e.name)));
  }
  return newest(below);
}

/** The existing video in a folder (or the storyboard file itself), if there is one. */
export async function detectProject(path: string): Promise<ProjectHint | undefined> {
  try {
    const file = await findStoryboard(path);
    if (!file) return undefined;
    const sb = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!sb || typeof sb !== "object" || Array.isArray(sb)) return undefined;
    return fromStoryboard(file, sb as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

const usualFile = () => join(configDir(), "brief.json");

/** The choices made for the last video, without its content. */
export function loadUsual(): Answers {
  try {
    const raw = JSON.parse(readFileSync(usualFile(), "utf8")) as { answers?: Record<string, unknown> };
    const out: Answers = {};
    for (const [k, v] of Object.entries(raw.answers ?? {})) if (typeof v === "string" && v && k !== "content") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Remember these choices as the user's usual ones. The content is never saved (it can be private). */
export function saveUsual(answers: Answers): void {
  try {
    const { content: _content, ...rest } = answers;
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(usualFile(), `${JSON.stringify({ savedAt: new Date().toISOString(), answers: rest }, null, 2)}\n`);
  } catch {
    // the habit is a convenience; never fail a brief over it
  }
}

/** The project's choices win over the usual ones. */
export function mergeSuggested(project: ProjectHint | undefined, usual: Answers | undefined): Suggested {
  const answers: Record<string, string> = {};
  const from: Suggested["from"] = {};
  for (const [k, v] of Object.entries(usual ?? {})) {
    answers[k] = v;
    from[k] = "usual";
  }
  for (const [k, v] of Object.entries(project?.answers ?? {})) {
    answers[k] = v;
    from[k] = "project";
  }
  return {
    answers,
    from,
    ...(project?.content ? { content: project.content } : {}),
    ...(project ? { project: { file: basename(project.file), summary: project.summary } } : {}),
  };
}
