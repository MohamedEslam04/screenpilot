import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RawEvent, Rect, ScreenInfo } from "./input/types.js";
import { normalizeEvents } from "./normalize.js";

/** Rebuild events.jsonl against another monitor, from the raw pointer log. */
export async function remapSession(dir: string, screenName: string): Promise<{ events: string; eventCount: number; screen: ScreenInfo }> {
  const abs = resolve(dir);
  const metaPath = join(abs, "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
    screens?: ScreenInfo[];
    capture: { contentRect: Rect };
    screen: Rect;
    events: string | null;
  };
  const screen = meta.screens?.find((s) => s.name === screenName);
  if (!screen) {
    throw new Error(`No monitor named "${screenName}" in this session (have: ${(meta.screens ?? []).map((s) => s.name).join(", ") || "none"})`);
  }
  const rawText = await readFile(join(abs, "pointer.raw.jsonl"), "utf8");
  const raw = rawText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RawEvent);
  const events = normalizeEvents(raw, 0, screen, meta.capture.contentRect);
  const eventsPath = join(abs, meta.events ?? "events.jsonl");
  await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  await writeFile(metaPath, `${JSON.stringify({ ...meta, screen, events: meta.events ?? "events.jsonl" }, null, 2)}\n`);
  return { events: eventsPath, eventCount: events.length, screen };
}
