import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsWatcher } from "../src/platform/windows/watcher.js";

const screen = { name: "\\\\.\\DISPLAY1", x: 0, y: 0, w: 1920, h: 1080 };
const monitor = { handle: 1n, screen, work: { x: 0, y: 0, w: 1920, h: 1040 }, primary: true };

function fakeWin32() {
  const s = {
    cursor: { x: 10, y: 20 },
    fg: 100n as bigint | null,
    frames: new Map<bigint, { x: number; y: number; w: number; h: number }>([
      [100n, { x: 50, y: 900, w: 800, h: 400 }],
      [200n, { x: 0, y: 1040, w: 1920, h: 40 }], // taskbar
    ]),
    titles: new Map<bigint, string>([[100n, "Notepad"]]),
  };
  const api = {
    cursorPos: () => ({ ...s.cursor }),
    monitors: () => [monitor],
    monitorOf: () => 1n,
    foreground: () => s.fg,
    frameRect: (h: bigint) => s.frames.get(h),
    title: (h: bigint) => s.titles.get(h) ?? "",
    owner: () => ({ thread: 1, pid: 42 }),
    exeName: () => "notepad.exe",
  };
  return { s, api };
}

describe("WindowsWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports monitors, the pointer only when it moves, and the cursor", async () => {
    const { s, api } = fakeWin32();
    const w = new WindowsWatcher(async () => api, false);
    await w.start();
    expect(w.screens()).toEqual([screen]);
    vi.advanceTimersByTime(100);
    s.cursor = { x: 11, y: 20 };
    vi.advanceTimersByTime(100);
    await w.stop();
    expect(w.events.map((e) => [e.type, e.px, e.py])).toEqual([
      ["move", 10, 20],
      ["move", 11, 20],
    ]);
    expect(w.cursor()).toEqual({ x: 11, y: 20 });
  });

  it("logs the active window clipped to the work area, on change only, skipping the taskbar", async () => {
    const { s, api } = fakeWin32();
    const w = new WindowsWatcher(async () => api, false);
    await w.start();
    vi.advanceTimersByTime(300);
    s.fg = 200n;
    vi.advanceTimersByTime(300);
    s.fg = 100n;
    s.titles.set(100n, "Notepad - saved");
    vi.advanceTimersByTime(300);
    await w.stop();
    expect(w.focus.map(({ at: _at, ...f }) => f)).toEqual([
      { id: "100", cls: "notepad.exe", title: "Notepad", x: 50, y: 900, w: 800, h: 140 },
      { id: "100", cls: "notepad.exe", title: "Notepad - saved", x: 50, y: 900, w: 800, h: 140 },
    ]);
  });

  it("stops polling after stop()", async () => {
    const { s, api } = fakeWin32();
    const w = new WindowsWatcher(async () => api, false);
    await w.start();
    await w.stop();
    s.cursor = { x: 500, y: 500 };
    vi.advanceTimersByTime(500);
    expect(w.events).toHaveLength(1);
  });
});
