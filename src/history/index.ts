import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../brand.js";

export type HistoryKind = "record" | "take" | "render" | "sequence";

/** One finished piece of work, one line of history.jsonl. */
export interface HistoryEvent {
  v: 1;
  /** ISO time the work finished. */
  at: string;
  kind: HistoryKind;
  status: "ok" | "failed";
  /** The session folder (record, take), the storyboard (render) or the sequence file (sequence). */
  path: string;
  /** The storyboard a take wrote (take only). */
  storyboard?: string;
  /** The video it made (render, sequence) or recorded. */
  output?: string;
  /** Length of that video in seconds. */
  durationSec?: number;
  quality?: string;
  /** How long the work took. */
  wallSeconds?: number;
  error?: string;
  /** Found on disk by `library import`, not recorded when it happened. */
  imported?: boolean;
}

/** Where the history is kept: an append-only JSON lines file in the config folder. */
export function historyFile(): string {
  return join(configDir(), "history.jsonl");
}

/** Add one line to the history. Never throws: history is a convenience and must not fail a render. */
export async function recordEvent(event: Omit<HistoryEvent, "v" | "at"> & { at?: string }, file = historyFile()): Promise<void> {
  try {
    const line: HistoryEvent = { v: 1, ...event, at: event.at ?? new Date().toISOString() };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(line)}\n`);
  } catch {
    // ignored on purpose
  }
}

const BLOCK = 64 * 1024;

const valid = (e: unknown): e is HistoryEvent =>
  !!e && typeof e === "object" && typeof (e as HistoryEvent).at === "string" && typeof (e as HistoryEvent).path === "string" && typeof (e as HistoryEvent).kind === "string";

/**
 * The newest events first. Reads the file backwards in blocks and stops at `limit`,
 * so the cost depends on the page, never on how long the history is. `before` (an
 * ISO time) continues after the last event of the previous page. Bad lines are skipped.
 */
export async function readHistory(opts: { limit?: number; before?: string; file?: string } = {}): Promise<HistoryEvent[]> {
  const limit = opts.limit ?? 50;
  const out: HistoryEvent[] = [];
  let handle;
  try {
    handle = await open(opts.file ?? historyFile(), "r");
  } catch {
    return out;
  }
  try {
    let pos = (await handle.stat()).size;
    let tail = Buffer.alloc(0); // the start of a line whose beginning is in an earlier block
    while (pos > 0 && out.length < limit) {
      const size = Math.min(BLOCK, pos);
      pos -= size;
      const block = Buffer.alloc(size);
      await handle.read(block, 0, size, pos);
      const data = Buffer.concat([block, tail]);
      const lines: Buffer[] = [];
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] === 0x0a) {
          lines.push(data.subarray(i + 1, end));
          end = i;
        }
      }
      tail = data.subarray(0, end);
      if (pos === 0) lines.push(tail);
      for (const raw of lines) {
        if (out.length >= limit) break;
        if (!raw.length) continue;
        try {
          const e: unknown = JSON.parse(raw.toString("utf8"));
          if (valid(e) && (!opts.before || e.at < opts.before)) out.push(e);
        } catch {
          // a torn or hand-edited line
        }
      }
    }
  } finally {
    await handle.close();
  }
  return out;
}
