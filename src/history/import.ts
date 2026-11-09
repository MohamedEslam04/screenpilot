import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type HistoryEvent, historyFile, readHistory } from "./index.js";

const MAX_DEPTH = 2;
const skipDir = (name: string) => name.startsWith(".") || name === "node_modules" || name.endsWith(".build") || name.endsWith(".check");

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  yield dir;
  if (depth >= MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory() && !skipDir(e.name)) yield* walk(join(dir, e.name), depth + 1);
}

const mtimeIso = async (file: string) => (await stat(file)).mtime.toISOString();

/** What one folder shows: a recording (meta.json) and/or a storyboard with a finished video next to it. */
async function eventsIn(dir: string): Promise<HistoryEvent[]> {
  const found: HistoryEvent[] = [];
  const meta = join(dir, "meta.json");
  if (existsSync(meta)) {
    try {
      const m = JSON.parse(await readFile(meta, "utf8")) as { video?: string; videoInfo?: { duration?: number } };
      if (m.video) {
        found.push({
          v: 1,
          at: await mtimeIso(meta),
          kind: "record",
          status: "ok",
          path: dir,
          output: join(dir, m.video),
          durationSec: typeof m.videoInfo?.duration === "number" ? m.videoInfo.duration : undefined,
          imported: true,
        });
      }
    } catch {
      // not a ScreenPilot session
    }
  }
  const storyboard = join(dir, "storyboard.json");
  const video = join(dir, "storyboard.mp4");
  if (existsSync(storyboard) && existsSync(video)) {
    found.push({ v: 1, at: await mtimeIso(video), kind: "render", status: "ok", path: storyboard, output: video, imported: true });
  }
  return found;
}

/**
 * Add work that was made before history existed: recordings and finished renders found
 * under `roots` (two folder levels deep). What is already in the history is left alone.
 * The file is rewritten in time order, so run it while no render is finishing.
 */
export async function importLibrary(roots: string[], file = historyFile()): Promise<{ added: number; total: number }> {
  const existing = await readHistory({ limit: Number.POSITIVE_INFINITY, file });
  const known = new Set(existing.map((e) => `${e.kind}|${e.path}`));
  const added: HistoryEvent[] = [];
  for (const root of roots) {
    for await (const dir of walk(resolve(root))) {
      for (const e of await eventsIn(dir)) {
        const key = `${e.kind}|${e.path}`;
        if (known.has(key)) continue;
        known.add(key);
        added.push(e);
      }
    }
  }
  if (!added.length) return { added: 0, total: existing.length };
  const all = [...existing, ...added].sort((a, b) => a.at.localeCompare(b.at));
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${all.map((e) => JSON.stringify(e)).join("\n")}\n`);
  await rename(tmp, file);
  return { added: added.length, total: all.length };
}
