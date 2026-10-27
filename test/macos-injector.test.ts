import { describe, expect, it } from "vitest";
import {
  kCGEventLeftMouseDown,
  kCGEventLeftMouseDragged,
  kCGEventLeftMouseUp,
  kCGEventMouseMoved,
  type MacEvent,
} from "../src/platform/macos/events.js";
import { MacInjector } from "../src/platform/macos/injector.js";

// Built-in Retina display (points) and an external one to its left, top-aligned: (100, 1000) is below the built-in, in no display.
const screens = [
  { name: "Built-in Retina Display", x: 0, y: 0, w: 1512, h: 982 },
  { name: "DELL U2720Q", x: -1920, y: 0, w: 1920, h: 1080 },
];

function fake(warmUpMs = 0) {
  const posted: MacEvent[] = [];
  let t = 0;
  const q = { post: (e: MacEvent) => void posted.push(e), cursor: () => ({ x: 7, y: 8 }) };
  const inj = new MacInjector(q, screens, () => t, warmUpMs);
  return { posted, inj, tick: (ms: number) => (t += ms) };
}

const mouse = (e: MacEvent) => (e.kind === "mouse" ? [e.type, e.x, e.y, e.clickState] : e.kind);

describe("MacInjector", () => {
  it("taps Shift once before the first key event (macOS drops the very first ones)", async () => {
    const { posted, inj } = fake(1);
    await inj.typeText("a", { before: () => {}, gap: () => 0 });
    await inj.pressCombo("cmd+c");
    const keys = posted.filter((e) => e.kind === "key").map((e) => (e.kind === "key" ? [e.keycode, e.down] : []));
    expect(keys.slice(0, 2)).toEqual([
      [0x38, true],
      [0x38, false],
    ]);
    expect(keys.filter(([k]) => k === 0x38)).toHaveLength(2);
  });

  it("moves on displays (points) and refuses gaps between them", async () => {
    const { posted, inj } = fake();
    expect(await inj.moveTo(-1000, 500.5)).toBe(true);
    expect(await inj.moveTo(100, 1000)).toBe(false);
    expect(await inj.moveTo(5000, 10)).toBe(false);
    expect(posted.map(mouse)).toEqual([[kCGEventMouseMoved, -1000, 500.5, 0]]);
  });

  it("clicks where the pointer was put, and drags with *Dragged moves", async () => {
    const { posted, inj } = fake();
    await inj.moveTo(100, 100);
    await inj.button("left", true);
    await inj.moveTo(200, 150);
    await inj.button("left", false);
    await inj.moveTo(210, 150);
    expect(posted.map(mouse)).toEqual([
      [kCGEventMouseMoved, 100, 100, 0],
      [kCGEventLeftMouseDown, 100, 100, 1],
      [kCGEventLeftMouseDragged, 200, 150, 0],
      [kCGEventLeftMouseUp, 200, 150, 1],
      [kCGEventMouseMoved, 210, 150, 0],
    ]);
  });

  it("marks the second quick click as a double click (macOS reads the click state)", async () => {
    const { posted, inj, tick } = fake();
    await inj.moveTo(100, 100);
    for (let i = 0; i < 2; i++) {
      await inj.button("left", true);
      tick(50);
      await inj.button("left", false);
      tick(70);
    }
    expect(posted.filter((e) => e.kind === "mouse" && e.type !== kCGEventMouseMoved).map((e) => (e as { clickState: number }).clickState)).toEqual([1, 1, 2, 2]);
  });

  it("uses the real cursor position for a click before any move", async () => {
    const { posted, inj } = fake();
    await inj.button("left", true);
    expect(posted[0]).toMatchObject({ x: 7, y: 8 });
  });

  it("types one character at a time, checking before each, CRLF as one Return", async () => {
    const { posted, inj } = fake();
    let checks = 0;
    await inj.typeText("a\r\n😀", { before: () => checks++, gap: () => 0 });
    expect(checks).toBe(3);
    expect(posted.map((e) => (e.kind === "key" ? [e.keycode, e.down, e.text ?? ""] : e.kind))).toEqual([
      [0x00, true, "a"],
      [0x00, false, "a"],
      [0x24, true, ""],
      [0x24, false, ""],
      [0x00, true, "😀"],
      [0x00, false, "😀"],
    ]);
  });

  it("stops typing when the check throws", async () => {
    const { posted, inj } = fake();
    let n = 0;
    const before = () => {
      if (++n === 2) throw new Error("interrupted");
    };
    await expect(inj.typeText("abc", { before, gap: () => 0 })).rejects.toThrow("interrupted");
    expect(posted).toHaveLength(2);
  });

  it("releases held buttons on close", async () => {
    const { posted, inj } = fake();
    await inj.moveTo(10, 10);
    await inj.button("left", true);
    await inj.close();
    expect(posted.at(-1)).toMatchObject({ kind: "mouse", type: kCGEventLeftMouseUp, x: 10, y: 10 });
  });
});
