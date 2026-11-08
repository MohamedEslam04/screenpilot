import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheHome } from "../brand.js";

export interface SpeedEntry {
  quality: string;
  workers: number;
  /** Length of the finished video. */
  outSeconds: number;
  /** Time the render took. */
  wallSeconds: number;
}

const KEEP_PER_QUALITY = 5;

/** Where the measured render speeds are kept. */
export function speedFile(): string {
  return join(cacheHome(), "render-speed.json");
}

const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** The stored entries; a missing, empty or corrupt file (or bad entry) is ignored. */
async function readEntries(file: string): Promise<SpeedEntry[]> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(data.entries)) return [];
    return data.entries.filter(
      (e): e is SpeedEntry => !!e && typeof e.quality === "string" && usable(e.workers) && usable(e.outSeconds) && usable(e.wallSeconds),
    );
  } catch {
    return [];
  }
}

/** Remember how fast a finished render was. Keeps the last 5 entries per quality. */
export async function recordSpeed(file: string, entry: SpeedEntry): Promise<void> {
  if (!usable(entry.outSeconds) || !usable(entry.wallSeconds)) return;
  const all = [...(await readEntries(file)), entry];
  const kept = all.filter((e, i) => all.slice(i + 1).filter((o) => o.quality === e.quality).length < KEEP_PER_QUALITY);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ entries: kept }, null, 2));
  await rename(tmp, file);
}

/** Seconds a render of `outSeconds` of video should take at this quality, from past renders. undefined without history. */
export async function estimateSeconds(file: string, quality: string, outSeconds: number): Promise<number | undefined> {
  const speeds = (await readEntries(file))
    .filter((e) => e.quality === quality)
    .map((e) => e.outSeconds / e.wallSeconds)
    .sort((a, b) => a - b);
  if (!speeds.length) return undefined;
  const mid = Math.floor(speeds.length / 2);
  const median = speeds.length % 2 ? speeds[mid]! : (speeds[mid - 1]! + speeds[mid]!) / 2;
  return outSeconds / median;
}

/** "40 s", "55 min", "1 h 15 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
