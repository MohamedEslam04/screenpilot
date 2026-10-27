// Characters → X keysyms → keycodes, from the core keyboard mapping. Pure,
// so it is unit tested without an X server.

export const NO_SYMBOL = 0;
export const XK_SHIFT_L = 0xffe1;

/** The core keyboard mapping (XGetKeyboardMapping for every keycode). */
export interface Keymap {
  /** First keycode (XDisplayKeycodes min, usually 8). */
  min: number;
  /** Keysyms per keycode. */
  per: number;
  /** `per` keysyms for each keycode from `min` on. */
  syms: number[];
}

/** Keysym for a character: Latin-1 as itself, Return/Tab for \n and \t, anything else as a Unicode keysym. */
export function keysymForChar(ch: string): number {
  if (ch === "\n" || ch === "\r") return 0xff0d;
  if (ch === "\t") return 0xff09;
  if (ch === "\b") return 0xff08;
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

/**
 * The keycode producing `sym` in keyboard group `group` (0 = first layout),
 * and whether Shift is needed. Core mapping columns are [group1 level1,
 * group1 level2, group2 level1, group2 level2, ...]; a group with no symbols
 * on a key falls back to group 1, and a lone lowercase letter gives its
 * uppercase with Shift (as Xlib does). Undefined = no key has it: remap a
 * spare keycode.
 */
export function findKeystroke(map: Keymap, sym: number, group = 0): { code: number; shift: boolean } | undefined {
  if (group > 1) return undefined; // groups 3+ have no reliable place in the core mapping
  const count = Math.floor(map.syms.length / map.per);
  const levels = (i: number): [number, number] => {
    const at = (c: number) => (c < map.per ? map.syms[i * map.per + c]! : NO_SYMBOL);
    let base = 2 * group;
    if (base > 0 && at(base) === NO_SYMBOL && at(base + 1) === NO_SYMBOL) base = 0;
    const l1 = at(base);
    let l2 = at(base + 1);
    if (l2 === NO_SYMBOL && l1 >= 0x61 && l1 <= 0x7a) l2 = l1 - 0x20; // 'a' alone also types 'A'
    return [l1, l2];
  };
  for (let i = 0; i < count; i++) if (levels(i)[0] === sym) return { code: map.min + i, shift: false };
  for (let i = 0; i < count; i++) if (levels(i)[1] === sym) return { code: map.min + i, shift: true };
  return undefined;
}

/** Keycodes with no symbols at all (safe to remap for a moment), highest first. */
export function spareKeycodes(map: Keymap, max = 10): number[] {
  const out: number[] = [];
  const count = Math.floor(map.syms.length / map.per);
  for (let i = count - 1; i >= 0 && out.length < max; i--) {
    const row = map.syms.slice(i * map.per, (i + 1) * map.per);
    if (row.every((s) => s === NO_SYMBOL)) out.push(map.min + i);
  }
  return out;
}
