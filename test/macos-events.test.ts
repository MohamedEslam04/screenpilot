import { describe, expect, it } from "vitest";
import {
  buttonEvent,
  charEvents,
  ClickCounter,
  comboEvents,
  kCGEventFlagMaskCommand as CMD,
  kCGEventFlagMaskNumericPad,
  kCGEventFlagMaskSecondaryFn,
  kCGEventFlagMaskShift as SHIFT,
  kCGEventLeftMouseDown,
  kCGEventLeftMouseDragged,
  kCGEventMouseMoved,
  kCGEventOtherMouseUp,
  kCGEventRightMouseDragged,
  moveEvent,
  parseComboMac,
  scrollEvent,
} from "../src/platform/macos/events.js";

const keys = (combo: string) => comboEvents(combo).map((e) => (e.kind === "key" ? [e.keycode, e.down ? "down" : "up", e.flags] : e.kind));

describe("macOS key codes", () => {
  it("presses a combo key by key with accumulating modifier flags, releases in reverse", () => {
    expect(keys("cmd+shift+t")).toEqual([
      [0x37, "down", CMD],
      [0x38, "down", CMD | SHIFT],
      [0x11, "down", CMD | SHIFT],
      [0x11, "up", CMD | SHIFT],
      [0x38, "up", CMD],
      [0x37, "up", 0],
    ]);
  });

  it("maps super/meta/win to Command and alt/option to Option", () => {
    expect(parseComboMac("super+meta+win+cmd").every((k) => k.code === 0x37)).toBe(true);
    expect(parseComboMac("alt+option+opt").every((k) => k.code === 0x3a)).toBe(true);
    expect(parseComboMac("ctrl")[0]!.code).toBe(0x3b);
  });

  it("adds Shift for shifted punctuation once", () => {
    expect(parseComboMac("cmd+?").map((k) => k.code)).toEqual([0x37, 0x38, 0x2c]);
    expect(parseComboMac("shift+?").map((k) => k.code)).toEqual([0x38, 0x2c]);
  });

  it("knows named and US-layout keys, and rejects unknown ones", () => {
    expect(parseComboMac("enter")[0]!.code).toBe(0x24);
    expect(parseComboMac("backspace")[0]!.code).toBe(0x33);
    expect(parseComboMac("delete")[0]!.code).toBe(0x75);
    expect(parseComboMac("f1")[0]!.code).toBe(0x7a);
    expect(parseComboMac("f12")[0]!.code).toBe(0x6f);
    expect(parseComboMac("cmd+a").map((k) => k.code)).toEqual([0x37, 0x00]);
    expect(parseComboMac("cmd+1").map((k) => k.code)).toEqual([0x37, 0x12]);
    expect(() => parseComboMac("cmd+nope")).toThrow('Unknown key "nope"');
  });

  it("gives arrows the numeric-pad and fn flags a real keyboard sends", () => {
    expect(keys("left")).toEqual([
      [0x7b, "down", kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn],
      [0x7b, "up", kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn],
    ]);
    expect(keys("shift+right")[1]).toEqual([0x7c, "down", SHIFT | kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn]);
  });
});

describe("macOS typing", () => {
  it("types US characters with their key code (and Shift) plus the text", () => {
    expect(charEvents("a")).toEqual([
      { kind: "key", keycode: 0x00, down: true, flags: 0, text: "a" },
      { kind: "key", keycode: 0x00, down: false, flags: 0, text: "a" },
    ]);
    expect(charEvents("A")[0]).toEqual({ kind: "key", keycode: 0x00, down: true, flags: SHIFT, text: "A" });
    expect(charEvents("!")[0]).toEqual({ kind: "key", keycode: 0x12, down: true, flags: SHIFT, text: "!" });
    expect(charEvents(" ")[0]).toMatchObject({ keycode: 0x31, flags: 0, text: " " });
  });

  it("types any other character as a Unicode string, whatever the layout", () => {
    expect(charEvents("م")[0]).toEqual({ kind: "key", keycode: 0, down: true, flags: 0, text: "م" });
    const emoji = charEvents("😀");
    expect(emoji[0]).toMatchObject({ text: "😀", flags: 0 });
    expect((emoji[0] as { text: string }).text.length).toBe(2); // both UTF-16 units in one event
  });

  it("presses Return and Tab as keys", () => {
    expect(charEvents("\n").map((e) => (e.kind === "key" ? [e.keycode, e.down, e.text] : e))).toEqual([
      [0x24, true, undefined],
      [0x24, false, undefined],
    ]);
    expect(charEvents("\t")[0]).toMatchObject({ keycode: 0x30 });
  });
});

describe("macOS mouse events", () => {
  it("moves become drags while a button is held", () => {
    expect(moveEvent(5, 6, new Set())).toMatchObject({ type: kCGEventMouseMoved, x: 5, y: 6 });
    expect(moveEvent(5, 6, new Set(["left"]))).toMatchObject({ type: kCGEventLeftMouseDragged, button: 0 });
    expect(moveEvent(5, 6, new Set(["right"]))).toMatchObject({ type: kCGEventRightMouseDragged, button: 1 });
  });

  it("maps buttons to Quartz event types and button numbers", () => {
    expect(buttonEvent("left", true, 1, 2, 1)).toEqual({ kind: "mouse", type: kCGEventLeftMouseDown, x: 1, y: 2, button: 0, clickState: 1 });
    expect(buttonEvent("middle", false, 1, 2, 1)).toMatchObject({ type: kCGEventOtherMouseUp, button: 2 });
  });

  it("scrolls 3 lines per step, positive = down/right (Quartz: positive = up/left)", () => {
    expect(scrollEvent(false, 1)).toEqual({ kind: "scroll", wheel1: -3, wheel2: 0 });
    expect(scrollEvent(false, -1)).toEqual({ kind: "scroll", wheel1: 3, wheel2: 0 });
    expect(scrollEvent(true, 1)).toEqual({ kind: "scroll", wheel1: 0, wheel2: -3 });
  });

  it("counts double clicks by time, place and button", () => {
    const c = new ClickCounter(500, 4);
    expect(c.press("left", 10, 10, 0)).toBe(1);
    expect(c.release("left")).toBe(1);
    expect(c.press("left", 11, 10, 120)).toBe(2);
    expect(c.release("left")).toBe(2);
    expect(c.press("left", 11, 10, 240)).toBe(3);
    expect(c.press("left", 11, 10, 2000)).toBe(1); // too late
    expect(c.press("left", 40, 10, 2100)).toBe(1); // moved
    expect(c.press("right", 40, 10, 2150)).toBe(1); // other button
  });
});
