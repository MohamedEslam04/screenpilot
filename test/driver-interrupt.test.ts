import { describe, expect, it } from "vitest";
import { Driver, UserInterrupted } from "../src/drive/index.js";
import type { Desktop, Injector, Watcher } from "../src/platform/types.js";

const screens = [{ name: "S1", x: 0, y: 0, w: 1000, h: 1000, model: "m" }];

// A pointer the "OS" reports: follows the injector, unless `moved` overrides it.
function fakes() {
  const cursor = { x: 0, y: 0 };
  const input = {
    moveTo: async (x: number, y: number) => {
      cursor.x = x;
      cursor.y = y;
      return true;
    },
    button: async () => {},
    wheel: async () => {},
    pressCombo: async () => {},
    typeText: async () => {},
    close: async () => {},
  } as Injector;
  const watcher = { cursor: () => ({ ...cursor }), screens: () => screens, focus: [] } as unknown as Watcher;
  return { cursor, driver: (opts = {}) => Driver.from({} as Desktop, input, watcher, opts) };
}

describe("Driver interrupt", () => {
  it("stops when someone else moves the pointer, and resume carries on", async () => {
    const f = fakes();
    const d = f.driver();
    await d.moveTo({ x: 0.1, y: 0.1 }, { dur: 0.05 });
    await new Promise((r) => setTimeout(r, 650)); // let the recent-move window pass
    f.cursor.x = 800;
    f.cursor.y = 800;
    await expect(d.click({ x: 0.2, y: 0.2 })).rejects.toBeInstanceOf(UserInterrupted);
    await expect(d.click({ x: 0.2, y: 0.2 })).rejects.toBeInstanceOf(UserInterrupted); // still stuck without resume
    d.resume();
    await expect(d.click({ x: 0.2, y: 0.2 })).resolves.toBeUndefined();
  });

  it("ignores pointer movement with interrupt off, but abort still stops", async () => {
    const f = fakes();
    const d = f.driver({ interrupt: "off" });
    await d.moveTo({ x: 0.1, y: 0.1 }, { dur: 0.05 });
    await new Promise((r) => setTimeout(r, 650));
    f.cursor.x = 800;
    f.cursor.y = 800;
    await expect(d.click({ x: 0.2, y: 0.2 })).resolves.toBeUndefined();
    d.abort();
    await expect(d.click({ x: 0.3, y: 0.3 })).rejects.toThrow(/abort/);
    d.resume();
    await expect(d.click({ x: 0.3, y: 0.3 })).resolves.toBeUndefined();
  });

  it("trims old actions only when asked", async () => {
    const f = fakes();
    const keep = f.driver();
    const trim = f.driver({ trimActions: true });
    for (const d of [keep, trim]) {
      await d.moveTo({ x: 0.5, y: 0.5 }, { dur: 0.05 });
      await new Promise((r) => setTimeout(r, 1100));
      await d.key("a");
    }
    expect(keep.actions.length).toBeGreaterThan(1);
    expect(trim.actions.length).toBe(1);
  });
});
