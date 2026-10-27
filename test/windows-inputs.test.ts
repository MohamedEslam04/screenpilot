import { describe, expect, it } from "vitest";
import {
  absoluteMove,
  buttonInput,
  charInputs,
  comboInputs,
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_HWHEEL,
  MOUSEEVENTF_MOVE,
  MOUSEEVENTF_VIRTUALDESK,
  MOUSEEVENTF_WHEEL,
  parseComboVk,
  wheelInput,
  type Win32Input,
} from "../src/platform/windows/inputs.js";

// Secondary 1920x1080 monitor left of a 2560x1440 primary: the virtual screen starts at x = -1920.
const virt = { x: -1920, y: 0, w: 4480, h: 1440 };

const mi = (i: Win32Input) => {
  if (i.type !== INPUT_MOUSE) throw new Error("not a mouse input");
  return i.u.mi;
};
const ki = (i: Win32Input) => {
  if (i.type !== INPUT_KEYBOARD) throw new Error("not a keyboard input");
  return i.u.ki;
};
/** [vk, scan, flags] per input, for compact assertions. */
const keys = (inputs: Win32Input[]) => inputs.map((i) => [ki(i).wVk, ki(i).wScan, ki(i).dwFlags]);

describe("absolute pointer moves", () => {
  it("normalizes over the virtual screen, including its negative origin", () => {
    const flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    expect(mi(absoluteMove(-1920, 0, virt))).toMatchObject({ dx: 0, dy: 0, dwFlags: flags });
    expect(mi(absoluteMove(2559, 1439, virt))).toMatchObject({ dx: 65535, dy: 65535, dwFlags: flags });
    // Primary monitor's top-left edge, mid height.
    expect(mi(absoluteMove(0, 720, virt))).toMatchObject({ dx: 28093, dy: 32790 });
  });

  it("clamps points outside the virtual screen", () => {
    expect(mi(absoluteMove(-5000, 99999, virt))).toMatchObject({ dx: 0, dy: 65535 });
  });
});

describe("buttons and wheel", () => {
  it("maps buttons to down/up flags", () => {
    expect(mi(buttonInput("left", true)).dwFlags).toBe(0x0002);
    expect(mi(buttonInput("left", false)).dwFlags).toBe(0x0004);
    expect(mi(buttonInput("right", true)).dwFlags).toBe(0x0008);
    expect(mi(buttonInput("middle", false)).dwFlags).toBe(0x0040);
  });

  it("scrolls one notch; positive = down / right, stored as an unsigned DWORD", () => {
    expect(mi(wheelInput(false, 1))).toMatchObject({ dwFlags: MOUSEEVENTF_WHEEL, mouseData: -120 >>> 0 });
    expect(mi(wheelInput(false, -1))).toMatchObject({ dwFlags: MOUSEEVENTF_WHEEL, mouseData: 120 });
    expect(mi(wheelInput(true, 1))).toMatchObject({ dwFlags: MOUSEEVENTF_HWHEEL, mouseData: 120 });
    expect(mi(wheelInput(true, -1)).mouseData).toBe(4294967176);
  });
});

describe("key combos", () => {
  it("parses modifiers, letters, digits and OEM keys to US-layout VK codes", () => {
    expect(parseComboVk("ctrl+shift+T")).toEqual([
      { vk: 0x11, extended: false },
      { vk: 0x10, extended: false },
      { vk: 0x54, extended: false },
    ]);
    expect(parseComboVk("alt+4").map((k) => k.vk)).toEqual([0x12, 0x34]);
    expect(parseComboVk("ctrl+/").map((k) => k.vk)).toEqual([0x11, 0xbf]);
    expect(parseComboVk("ctrl+[").map((k) => k.vk)).toEqual([0x11, 0xdb]);
    expect(parseComboVk("F5")).toEqual([{ vk: 0x74, extended: false }]);
    expect(parseComboVk("f24")).toEqual([{ vk: 0x87, extended: false }]);
  });

  it("adds Shift for shifted punctuation", () => {
    expect(parseComboVk("ctrl+?").map((k) => k.vk)).toEqual([0x11, 0x10, 0xbf]);
    expect(parseComboVk("ctrl+shift+?").map((k) => k.vk)).toEqual([0x11, 0x10, 0xbf]);
  });

  it("marks navigation keys and Win as extended", () => {
    for (const k of ["left", "up", "right", "down", "home", "end", "pageup", "pgdn", "delete", "insert", "win"]) {
      expect(parseComboVk(k)[0]!.extended).toBe(true);
    }
    for (const k of ["enter", "tab", "esc", "backspace", "space", "ctrl", "a"]) {
      expect(parseComboVk(k)[0]!.extended).toBe(false);
    }
  });

  it("rejects unknown keys", () => {
    expect(() => parseComboVk("ctrl+nope")).toThrow(/nope/);
    expect(() => parseComboVk("ctrl+م")).toThrow(/م/);
  });

  it("presses in order and releases in reverse, with the extended flag kept on key-up", () => {
    expect(keys(comboInputs("ctrl+end"))).toEqual([
      [0x11, 0, 0],
      [0x23, 0, KEYEVENTF_EXTENDEDKEY],
      [0x23, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP],
      [0x11, 0, KEYEVENTF_KEYUP],
    ]);
  });
});

describe("unicode typing", () => {
  const U = KEYEVENTF_UNICODE;
  const UP = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

  it("types ASCII as a UTF-16 unit down/up", () => {
    expect(keys(charInputs("a"))).toEqual([
      [0, 0x61, U],
      [0, 0x61, UP],
    ]);
  });

  it("types Arabic without any layout", () => {
    expect(keys(charInputs("م"))).toEqual([
      [0, 0x645, U],
      [0, 0x645, UP],
    ]);
  });

  it("sends both halves of a surrogate pair", () => {
    expect(keys(charInputs("😀"))).toEqual([
      [0, 0xd83d, U],
      [0, 0xd83d, UP],
      [0, 0xde00, U],
      [0, 0xde00, UP],
    ]);
  });

  it("presses Enter and Tab for newline and tab", () => {
    expect(keys(charInputs("\n"))).toEqual([
      [0x0d, 0, 0],
      [0x0d, 0, KEYEVENTF_KEYUP],
    ]);
    expect(keys(charInputs("\t"))).toEqual([
      [0x09, 0, 0],
      [0x09, 0, KEYEVENTF_KEYUP],
    ]);
  });
});
