// X11 keysyms for keyboard injection through the portal.

const NAMED: Record<string, number> = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  backspace: 0xff08,
  escape: 0xff1b,
  esc: 0xff1b,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  space: 0x20,
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  super: 0xffeb,
  meta: 0xffeb,
  win: 0xffeb,
  menu: 0xff67,
  printscreen: 0xff61,
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = 0xffbe + i - 1;

/** Keysym for one character, or null when it is outside Latin-1 (type it via the clipboard). */
export function charKeysym(ch: string): number | null {
  if (ch === "\n") return NAMED.enter!;
  if (ch === "\t") return NAMED.tab!;
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return null;
}

/** "ctrl+shift+t" → keysyms in press order. */
export function parseCombo(combo: string): number[] {
  return combo
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const named = NAMED[k.toLowerCase()];
      if (named !== undefined) return named;
      if ([...k].length === 1) {
        const sym = charKeysym(k.toLowerCase());
        if (sym !== null) return sym;
      }
      throw new Error(`Unknown key "${k}" in "${combo}"`);
    });
}

// US layout: shifted characters and the key that produces them. We press
// Shift ourselves: injecting a shifted keysym makes KWin press Shift on its
// own and it can stay latched, turning "A1" into "A!".
const SHIFTED: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

export const SHIFT = 0xffe1;

/** The unshifted key for a character and whether Shift is needed; null = type it via the clipboard. */
export function charStroke(ch: string): { sym: number; shift: boolean } | null {
  if (ch === "\n") return { sym: NAMED.enter!, shift: false };
  if (ch === "\t") return { sym: NAMED.tab!, shift: false };
  if (/^[A-Z]$/.test(ch)) return { sym: ch.toLowerCase().codePointAt(0)!, shift: true };
  const base = SHIFTED[ch];
  if (base) return { sym: base.codePointAt(0)!, shift: true };
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return { sym: cp, shift: false };
  return null;
}

/** Split text into runs typed key-by-key and runs that need the clipboard. */
export function splitTyping(text: string): { keys: boolean; text: string }[] {
  const runs: { keys: boolean; text: string }[] = [];
  for (const ch of text) {
    const keys = charStroke(ch) !== null;
    const last = runs.at(-1);
    if (last && last.keys === keys) last.text += ch;
    else runs.push({ keys, text: ch });
  }
  return runs;
}
