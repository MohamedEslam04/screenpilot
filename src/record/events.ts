import { readFile } from "node:fs/promises";

// events.jsonl: one JSON object per line. `t` is seconds since the recording
// started; x/y are normalized 0..1 of the recorded screen.
export type InputEventType = "move" | "down" | "up" | "scroll" | "key";

export interface InputEvent {
  t: number;
  type: InputEventType;
  x?: number;
  y?: number;
  button?: number;
  key?: string;
}

export async function readEvents(file: string): Promise<InputEvent[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as InputEvent);
}

export function clicksOf(events: InputEvent[]): { t: number; x: number; y: number }[] {
  return events
    .filter((e) => e.type === "down" && e.x !== undefined && e.y !== undefined)
    .map((e) => ({ t: e.t, x: e.x!, y: e.y! }));
}
