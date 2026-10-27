import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CgWindow, Display } from "../src/platform/macos/geometry.js";
import { MacWatcher } from "../src/platform/macos/watcher.js";

const display: Display = {
  id: 1,
  screen: { name: "Built-in Retina Display", x: 0, y: 0, w: 1512, h: 982, deviceId: "1" },
  work: { x: 0, y: 37, w: 1512, h: 875 },
  pixelW: 3024,
  pixelH: 1964,
  scale: 2,
  index: 0,
};

const win = (o: Partial<CgWindow>): CgWindow => ({ id: 1, pid: 10, owner: "Safari", name: "Apple", layer: 0, alpha: 1, onScreen: true, bounds: { x: 0, y: 0, w: 100, h: 100 }, ...o });

function fake(trusted = true) {
  const s = {
    cursor: { x: 10.5, y: 20 },
    focused: 10 as number | undefined,
    windows: [
      win({ id: 2, layer: 24, owner: "Control Center", bounds: { x: 1400, y: 0, w: 30, h: 37 } }),
      win({ id: 7, pid: 10, name: "Apple", bounds: { x: 100, y: 25, w: 1200, h: 950 } }), // under the menu bar and the Dock
      win({ id: 8, pid: 20, owner: "Terminal", name: "zsh", bounds: { x: 50, y: 300, w: 600, h: 400 } }),
    ],
  };
  const api = { cursor: () => ({ ...s.cursor }), windows: () => s.windows, focusedPid: () => s.focused, axTrusted: () => trusted };
  return { s, api };
}

describe("MacWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports displays, the pointer (points) only when it moves, and the cursor", async () => {
    const { s, api } = fake();
    const w = new MacWatcher(async () => api, async () => [display], false);
    await w.start();
    expect(w.screens()).toEqual([display.screen]);
    vi.advanceTimersByTime(100);
    s.cursor = { x: 11, y: 20 };
    vi.advanceTimersByTime(100);
    await w.stop();
    expect(w.events.map((e) => [e.type, e.px, e.py])).toEqual([
      ["move", 10.5, 20],
      ["move", 11, 20],
    ]);
    expect(w.cursor()).toEqual({ x: 11, y: 20 });
  });

  it("logs the focused app's window clipped to the work area, on change only", async () => {
    const { s, api } = fake();
    const w = new MacWatcher(async () => api, async () => [display], false);
    await w.start();
    vi.advanceTimersByTime(300);
    s.focused = 20;
    vi.advanceTimersByTime(300);
    await w.stop();
    expect(w.focus.map(({ at: _at, ...f }) => f)).toEqual([
      { id: "7", cls: "Safari", title: "Apple", x: 100, y: 37, w: 1200, h: 875 },
      { id: "8", cls: "Terminal", title: "zsh", x: 50, y: 300, w: 600, h: 400 },
    ]);
  });

  it("uses the front-most window without Accessibility, and says clicks are not logged", async () => {
    const { s, api } = fake(false);
    s.windows = [s.windows[2]!, s.windows[1]!];
    const w = new MacWatcher(async () => api, async () => [display], true);
    await w.start();
    await w.stop();
    expect(w.focus[0]).toMatchObject({ id: "8" });
    expect(w.warnings.join(" ")).toContain("Accessibility");
  });
});
