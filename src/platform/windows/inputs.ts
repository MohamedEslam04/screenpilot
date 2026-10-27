import type { Rect } from "../../record/input/types.js";
import type { MouseButton } from "../types.js";

// SendInput INPUT records as plain objects (koffi encodes them as-is; see
// win32.ts for the struct). No koffi here so this stays testable anywhere.

export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF_MOVE = 0x0001;
export const MOUSEEVENTF_WHEEL = 0x0800;
export const MOUSEEVENTF_HWHEEL = 0x1000;
export const MOUSEEVENTF_VIRTUALDESK = 0x4000;
export const MOUSEEVENTF_ABSOLUTE = 0x8000;
const BUTTON_FLAGS: Record<MouseButton, [down: number, up: number]> = {
  left: [0x0002, 0x0004],
  right: [0x0008, 0x0010],
  middle: [0x0020, 0x0040],
};

export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_UNICODE = 0x0004;

const WHEEL_DELTA = 120;

export interface MouseInput {
  dx: number;
  dy: number;
  mouseData: number;
  dwFlags: number;
  time: number;
  dwExtraInfo: number;
}

export interface KeybdInput {
  wVk: number;
  wScan: number;
  dwFlags: number;
  time: number;
  dwExtraInfo: number;
}

export type Win32Input = { type: typeof INPUT_MOUSE; u: { mi: MouseInput } } | { type: typeof INPUT_KEYBOARD; u: { ki: KeybdInput } };

const mouse = (dx: number, dy: number, mouseData: number, dwFlags: number): Win32Input => ({
  type: INPUT_MOUSE,
  u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } },
});

const key = (wVk: number, wScan: number, dwFlags: number): Win32Input => ({
  type: INPUT_KEYBOARD,
  u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } },
});

/** Absolute move in global px; SendInput wants 0..65535 over the whole virtual screen. */
export function absoluteMove(x: number, y: number, virt: Rect): Win32Input {
  const norm = (v: number, origin: number, size: number) =>
    Math.min(65535, Math.max(0, Math.round(((v - origin) * 65535) / Math.max(1, size - 1))));
  return mouse(norm(x, virt.x, virt.w), norm(y, virt.y, virt.h), 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
}

export function buttonInput(b: MouseButton, down: boolean): Win32Input {
  return mouse(0, 0, 0, BUTTON_FLAGS[b][down ? 0 : 1]);
}

/** One notch; positive = down / right. Windows' vertical wheel is positive = up. mouseData is a DWORD. */
export function wheelInput(horizontal: boolean, step: 1 | -1): Win32Input {
  const delta = (horizontal ? step : -step) * WHEEL_DELTA;
  return mouse(0, 0, delta >>> 0, horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL);
}

export interface VKey {
  vk: number;
  extended: boolean;
}

export const VK_SHIFT = 0x10;
export const VK_MENU = 0x12;

// Names as in drive/keys.ts. Extended keys need KEYEVENTF_EXTENDEDKEY or
// they hit their numpad twins (End → numpad 1 with NumLock off, etc.).
const NAMED: Record<string, VKey> = {};
const named = (vk: number, extended: boolean, ...names: string[]) => {
  for (const n of names) NAMED[n] = { vk, extended };
};
named(0x0d, false, "enter", "return");
named(0x09, false, "tab");
named(0x08, false, "backspace");
named(0x1b, false, "escape", "esc");
named(0x2e, true, "delete", "del");
named(0x2d, true, "insert");
named(0x24, true, "home");
named(0x23, true, "end");
named(0x21, true, "pageup", "pgup");
named(0x22, true, "pagedown", "pgdn");
named(0x25, true, "left");
named(0x26, true, "up");
named(0x27, true, "right");
named(0x28, true, "down");
named(0x20, false, "space");
named(VK_SHIFT, false, "shift");
named(0x11, false, "ctrl", "control");
named(VK_MENU, false, "alt");
named(0x5b, true, "super", "meta", "win");
named(0x5d, true, "menu");
named(0x2c, true, "printscreen");
for (let i = 1; i <= 24; i++) named(0x70 + i - 1, false, `f${i}`);

// US layout OEM keys, and shifted characters → their unshifted key.
const OEM: Record<string, number> = { ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde };
const SHIFTED: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

/** VK code for an unshifted US-layout character. */
function charVk(ch: string): number | undefined {
  if (/^[a-z]$/.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
  return OEM[ch];
}

/** "ctrl+shift+t" → VK codes in press order; shifted punctuation ("ctrl+?") adds Shift. */
export function parseComboVk(combo: string): VKey[] {
  const out: VKey[] = [];
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
    const vk = charVk(base ?? ch);
    if (vk === undefined) throw new Error(`Unknown key "${k}" in "${combo}"`);
    if (base && shiftAt < 0) shiftAt = out.length;
    out.push({ vk, extended: false });
  }
  if (shiftAt >= 0 && !out.some((k) => k.vk === VK_SHIFT)) out.splice(shiftAt, 0, { vk: VK_SHIFT, extended: false });
  return out;
}

export function keyInput(k: VKey, down: boolean): Win32Input {
  return key(k.vk, 0, (k.extended ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP));
}

/** Press everything in order, release in reverse. */
export function comboInputs(combo: string): Win32Input[] {
  const keys = parseComboVk(combo);
  return [...keys.map((k) => keyInput(k, true)), ...[...keys].reverse().map((k) => keyInput(k, false))];
}

/**
 * One character (code point): Enter/Tab as keys, anything else as
 * KEYEVENTF_UNICODE per UTF-16 unit, so the keyboard layout never matters.
 */
export function charInputs(ch: string): Win32Input[] {
  const special = ch === "\n" ? NAMED.enter : ch === "\t" ? NAMED.tab : undefined;
  if (special) return [keyInput(special, true), keyInput(special, false)];
  const out: Win32Input[] = [];
  for (let i = 0; i < ch.length; i++) {
    const unit = ch.charCodeAt(i);
    out.push(key(0, unit, KEYEVENTF_UNICODE), key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
  }
  return out;
}
