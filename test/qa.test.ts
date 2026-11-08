import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isFlat, outsideFraction, qaStoryboard } from "../src/storyboard/qa.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("isFlat", () => {
  it("flags a nearly uniform crop", () => expect(isFlat({ ylow: 235, yhigh: 240 })).toBe(true));
  it("passes a crop with contrast", () => expect(isFlat({ ylow: 30, yhigh: 230 })).toBe(false));
  it("treats a spread of exactly 12 as not flat", () => expect(isFlat({ ylow: 100, yhigh: 112 })).toBe(false));
});

describe("outsideFraction", () => {
  it("is the share of the view outside the window", () => {
    const f = outsideFraction({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.043, y: 0.066, w: 0.915, h: 0.915 });
    expect(f).toBeCloseTo(0.164, 2);
  });
  it("is 0 for a view inside the window", () => {
    expect(outsideFraction({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(0);
  });
  it("is 1 for a view that does not touch the window", () => {
    expect(outsideFraction({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toBe(1);
  });
});

describe("qaStoryboard", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function fixture(filter: string, storyboard: object, windows?: object): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "qa-"));
    dirs.push(dir);
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", filter, join(dir, "raw.mp4")]);
    expect(made.status).toBe(0);
    await writeFile(join(dir, "storyboard.json"), JSON.stringify({ source: "raw.mp4", ...storyboard }));
    if (windows) await writeFile(join(dir, "windows.jsonl"), `${JSON.stringify(windows)}\n`);
    return join(dir, "storyboard.json");
  }

  it.skipIf(!hasFfmpeg)("flags an empty highlight and a view outside the window", async () => {
    const sb = await fixture(
      "color=white:s=320x180:r=10:d=2",
      {
        highlights: [{ at: 0.2, dur: 1, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
        views: [{ at: 0.5, rect: { x: 0, y: 0, w: 0.5, h: 1 } }],
      },
      { t: 0, id: "1", cls: "app", title: "App", x: 0.043, y: 0.066, w: 0.915, h: 0.915 },
    );
    const warnings = await qaStoryboard(sb);
    expect(warnings.some((w) => w.startsWith("[empty-highlight] highlights[0] at 0.2s frames a flat area"))).toBe(true);
    expect(warnings.some((w) => /^\[view-outside-window\] views\[0\] \(0\.5s\) shows 16% outside/.test(w))).toBe(true);
  });

  it.skipIf(!hasFfmpeg)("is quiet without windows.jsonl and with a textured highlight", async () => {
    const sb = await fixture("testsrc=s=320x180:r=10:d=2", {
      highlights: [{ at: 0.2, dur: 1, x: 0.1, y: 0.1, w: 0.6, h: 0.6 }],
      views: [{ at: 0, rect: { x: 0, y: 0, w: 0.5, h: 1 } }],
    });
    expect(await qaStoryboard(sb)).toEqual([]);
  });
});
