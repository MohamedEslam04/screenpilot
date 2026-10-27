import type { MouseButton } from "../types.js";

// Quartz (CGEvent) input as plain descriptions: quartz.ts turns each one into
// a CGEvent and posts it. No koffi here so this stays testable anywhere.
// Coordinates are global display POINTS (top-left of the main display is
// 0,0, y down), the unit CGEvent, CGWindowList and the AX API all use.

// CGEventType
export const kCGEventLeftMouseDown = 1;
export const kCGEventLeftMouseUp = 2;
export const kCGEventRightMouseDown = 3;
export const kCGEventRightMouseUp = 4;
export const kCGEventMouseMoved = 5;
export const kCGEventLeftMouseDragged = 6;
export const kCGEventRightMouseDragged = 7;
export const kCGEventOtherMouseDown = 25;
export const kCGEventOtherMouseUp = 26;
export const kCGEventOtherMouseDragged = 27;

// CGMouseButton
const BUTTON_NUMBER: Record<MouseButton, number> = { left: 0, right: 1, middle: 2 };

// CGEventFlags
export const kCGEventFlagMaskShift = 0x20000;
export const kCGEventFlagMaskControl = 0x40000;
export const kCGEventFlagMaskAlternate = 0x80000;
export const kCGEventFlagMaskCommand = 0x100000;
export const kCGEventFlagMaskNumericPad = 0x200000;
export const kCGEventFlagMaskSecondaryFn = 0x800000;

export type MacEvent =
  | { kind: "mouse"; type: number; x: number; y: number; button: number; clickState: number }
  | { kind: "key"; keycode: number; down: boolean; flags: number; text?: string }
  /** Lines; wheel1 is vertical (positive = up), wheel2 horizontal (positive = left), as Quartz has them. */
  | { kind: "scroll"; wheel1: number; wheel2: number };

/** What a pointer move is while buttons are held: macOS apps only see a drag in *Dragged events. */
export function moveEvent(x: number, y: number, held: ReadonlySet<MouseButton>): MacEvent {
  const b: MouseButton | undefined = held.has("left") ? "left" : held.has("right") ? "right" : held.has("middle") ? "middle" : undefined;
  const type =
    b === "left" ? kCGEventLeftMouseDragged : b === "right" ? kCGEventRightMouseDragged : b === "middle" ? kCGEventOtherMouseDragged : kCGEventMouseMoved;
  return { kind: "mouse", type, x, y, button: BUTTON_NUMBER[b ?? "left"], clickState: 0 };
}

export function buttonEvent(b: MouseButton, down: boolean, x: number, y: number, clickState: number): MacEvent {
  const type =
    b === "left"
      ? down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp
      : b === "right"
        ? down ? kCGEventRightMouseDown : kCGEventRightMouseUp
        : down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
  return { kind: "mouse", type, x, y, button: BUTTON_NUMBER[b], clickState };
}

export const LINES_PER_STEP = 3;

/** One wheel notch; positive = down / right (our convention), mapped to Quartz's signs. */
export function scrollEvent(horizontal: boolean, step: 1 | -1): MacEvent {
  return horizontal ? { kind: "scroll", wheel1: 0, wheel2: -step * LINES_PER_STEP } : { kind: "scroll", wheel1: -step * LINES_PER_STEP, wheel2: 0 };
}

/**
 * macOS apps read double-clicks from the event's click state, not from
 * timing, so synthetic presses must count clicks themselves: a press of the
 * same button close in time and place continues the series.
 */
export class ClickCounter {
  private last?: { button: MouseButton; at: number; x: number; y: number; count: number };

  constructor(
    private intervalMs = 500,
    private slopPx = 4,
  ) {}

  /** Click state for a button press at `now` (ms). */
  press(button: MouseButton, x: number, y: number, now: number): number {
    const l = this.last;
    const same = l && l.button === button && now - l.at <= this.intervalMs && Math.hypot(x - l.x, y - l.y) <= this.slopPx;
    const count = same ? l.count + 1 : 1;
    this.last = { button, at: now, x, y, count };
    return count;
  }

  /** Click state for the matching release (same as its press). */
  release(button: MouseButton): number {
    return this.last?.button === button ? this.last.count : 1;
  }
}

// Virtual key codes (Carbon kVK_*, ANSI positions). Names as in drive/keys.ts,
// plus the Mac names (cmd, option). super/meta/win are Command.
export interface MacKey {
  code: number;
  /** Modifier flag this key sets while held. */
  modifier?: number;
  /** Flags a real keyboard adds to this key (arrows: numeric pad + fn). */
  extra?: number;
}

const NAMED: Record<string, MacKey> = {};
const named = (code: number, names: string[], modifier?: number, extra?: number) => {
  for (const n of names) NAMED[n] = { code, ...(modifier ? { modifier } : {}), ...(extra ? { extra } : {}) };
};
const NAV = kCGEventFlagMaskSecondaryFn;
const ARROW = kCGEventFlagMaskSecondaryFn | kCGEventFlagMaskNumericPad;
named(0x24, ["enter", "return"]);
named(0x30, ["tab"]);
named(0x33, ["backspace"]);
named(0x35, ["escape", "esc"]);
named(0x75, ["delete", "del"], undefined, NAV); // forward delete
named(0x72, ["insert", "help"], undefined, NAV);
named(0x73, ["home"], undefined, NAV);
named(0x77, ["end"], undefined, NAV);
named(0x74, ["pageup", "pgup"], undefined, NAV);
named(0x79, ["pagedown", "pgdn"], undefined, NAV);
named(0x7b, ["left"], undefined, ARROW);
named(0x7e, ["up"], undefined, ARROW);
named(0x7c, ["right"], undefined, ARROW);
named(0x7d, ["down"], undefined, ARROW);
named(0x31, ["space"]);
named(0x38, ["shift"], kCGEventFlagMaskShift);
named(0x3b, ["ctrl", "control"], kCGEventFlagMaskControl);
named(0x3a, ["alt", "option", "opt"], kCGEventFlagMaskAlternate);
named(0x37, ["cmd", "command", "super", "meta", "win"], kCGEventFlagMaskCommand);
named(0x39, ["capslock"]);
const F_KEYS = [0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a];
F_KEYS.forEach((code, i) => named(code, [`f${i + 1}`], undefined, NAV));

// Characters on the US ANSI layout → key code.
const CHAR_CODES: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f,
  y: 0x10, t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1a, "-": 0x1b, "8": 0x1c,
  "0": 0x1d, "]": 0x1e, o: 0x1f, u: 0x20, "[": 0x21, i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27, k: 0x28, ";": 0x29, "\\": 0x2a,
  ",": 0x2b, "/": 0x2c, n: 0x2d, m: 0x2e, ".": 0x2f, "`": 0x32, " ": 0x31,
};
const SHIFTED: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

/** "cmd+shift+t" → keys in press order; shifted punctuation ("cmd+?") adds Shift. */
export function parseComboMac(combo: string): MacKey[] {
  const out: MacKey[] = [];
  let shiftAt = -1;
  for (const k of combo
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const n = NAMED[k.toLowerCase()];
    if (n) {
      out.push(n);
      continue;
    }
    const ch = k.length === 1 ? k.toLowerCase() : "";
    const base = SHIFTED[ch];
    const code = CHAR_CODES[base ?? ch];
    if (code === undefined) throw new Error(`Unknown key "${k}" in "${combo}"`);
    if (base && shiftAt < 0) shiftAt = out.length;
    out.push({ code });
  }
  if (shiftAt >= 0 && !out.some((k) => k.modifier === kCGEventFlagMaskShift)) out.splice(shiftAt, 0, NAMED.shift!);
  return out;
}

/** Press everything in order (modifier flags accumulate), release in reverse. */
export function comboEvents(combo: string): MacEvent[] {
  const keys = parseComboMac(combo);
  const out: MacEvent[] = [];
  let flags = 0;
  for (const k of keys) {
    flags |= k.modifier ?? 0;
    out.push({ kind: "key", keycode: k.code, down: true, flags: flags | (k.extra ?? 0) });
  }
  for (const k of [...keys].reverse()) {
    flags &= ~(k.modifier ?? 0);
    out.push({ kind: "key", keycode: k.code, down: false, flags: flags | (k.extra ?? 0) });
  }
  return out;
}

/**
 * One character (code point) as a key press. Enter/Tab are real keys; any
 * other character carries its text as the event's Unicode string, so the
 * keyboard layout never matters (Arabic, emoji). US-layout characters also
 * get their real key code and Shift, so web pages see sensible key/code.
 */
export function charEvents(ch: string): MacEvent[] {
  if (ch === "\n" || ch === "\t") {
    const code = ch === "\n" ? 0x24 : 0x30;
    return [
      { kind: "key", keycode: code, down: true, flags: 0 },
      { kind: "key", keycode: code, down: false, flags: 0 },
    ];
  }
  const upper = /^[A-Z]$/.test(ch);
  const base = SHIFTED[ch];
  const code = CHAR_CODES[base ?? (upper ? ch.toLowerCase() : ch)];
  const flags = code !== undefined && (upper || base) ? kCGEventFlagMaskShift : 0;
  // Key code 0 is "a" on ANSI; with a Unicode string the string wins.
  const keycode = code ?? 0;
  return [
    { kind: "key", keycode, down: true, flags, text: ch },
    { kind: "key", keycode, down: false, flags, text: ch },
  ];
}
