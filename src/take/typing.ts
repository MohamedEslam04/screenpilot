import type { Typing } from "../storyboard/schema.js";

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The `typing` item for a `type` step that ran from `start` to `end` (seconds since the
 * recording began). A secret (`{ env }`) is only timed, never copied, so it cannot end up
 * in a storyboard.
 */
export function typingSpan(step: { type: string | { env: string } }, start: number, end: number): Typing {
  const span: Typing = { at: round(start), dur: Math.max(0.2, round(end - start)) };
  if (typeof step.type === "string") span.text = step.type;
  return span;
}
