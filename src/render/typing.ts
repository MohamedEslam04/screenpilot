// The key presses of a typing span. The typing sound (sfx.ts) and the key-caps (plan.ts, html.ts)
// both read them, so the letters appear on the very press that makes the sound.

/** Presses a second of typing without text, and the most a text can make. */
const TYPING_RATE = 7;
const MAX_PRESSES = 400;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Small seeded generator, so a typing rhythm is the same on every render. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The press that shows character `charIndex` of a text of `textLength` characters, when there
 * are `pressCount` presses (fewer than the characters in a very long text): the characters
 * are spread evenly over the presses, so later words do not all pile up on the last one.
 */
export function pressFor(charIndex: number, textLength: number, pressCount: number): number {
  if (textLength <= 0 || pressCount <= 0) return 0;
  return Math.min(pressCount - 1, Math.max(0, Math.ceil(((charIndex + 1) * pressCount) / textLength) - 1));
}

/** Source times of the key presses of a typing span: one per character (or ~7 a second), evenly spread with a little human unevenness. */
export function typingPresses(span: { at: number; dur: number; text?: string }, seed: number): number[] {
  const n = span.text !== undefined ? Math.min(span.text.length, MAX_PRESSES) : Math.round(span.dur * TYPING_RATE);
  if (n <= 0) return [];
  const step = span.dur / n;
  const rnd = mulberry32(Math.imul(seed + 1, 2654435761) ^ Math.round(span.at * 1000));
  return Array.from({ length: n }, (_, i) => round(span.at + (i + 0.5) * step + (rnd() - 0.5) * step * 0.5));
}

