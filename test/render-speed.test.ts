import { describe, expect, it } from "vitest";
import { buildCutArgs } from "../src/render/cut.js";
import { draftFps } from "../src/render/draft.js";
import { autoWorkers } from "../src/render/workers.js";
import { makeTimer } from "../src/util/timing.js";

const GB = 1024 ** 3;

describe("autoWorkers", () => {
  it("uses half the cores when memory is plentiful, capped at 6", () => {
    expect(autoWorkers(12, 32 * GB)).toBe(6);
    expect(autoWorkers(32, 64 * GB)).toBe(6);
    expect(autoWorkers(8, 32 * GB)).toBe(4);
  });

  it("is limited by free memory (about 1.5 GB per worker plus a 1 GB reserve)", () => {
    expect(autoWorkers(12, 6 * GB)).toBe(3);
    expect(autoWorkers(12, 4 * GB)).toBe(2);
  });

  it("never goes below one worker", () => {
    expect(autoWorkers(1, 32 * GB)).toBe(1);
    expect(autoWorkers(12, 1 * GB)).toBe(1);
    expect(autoWorkers(12, 0)).toBe(1);
  });
});

describe("makeTimer", () => {
  it("runs the work and logs its duration when enabled", async () => {
    const lines: string[] = [];
    const time = makeTimer(true, (m) => lines.push(m));
    const out = await time("cut", async () => 42);
    expect(out).toBe(42);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^time cut: \d+\.\d{2}s$/);
  });

  it("logs nothing when disabled but still returns the result", async () => {
    const lines: string[] = [];
    const time = makeTimer(false, (m) => lines.push(m));
    expect(await time("cut", async () => "ok")).toBe("ok");
    expect(lines).toEqual([]);
  });

  it("still logs the duration when the work throws", async () => {
    const lines: string[] = [];
    const time = makeTimer(true, (m) => lines.push(m));
    await expect(
      time("voice", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lines[0]).toMatch(/^time voice: /);
  });
});

describe("draft cut", () => {
  const base = { source: "in.mp4", output: "out.mp4", pieces: [], fps: 30, sourceDuration: 10, keepAudio: false };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("keeps the high-quality cut by default", () => {
    const args = buildCutArgs(base, "f.filter", "-filter_complex_script");
    expect(after(args, "-preset")).toBe("veryfast");
    expect(after(args, "-crf")).toBe("16");
  });

  it("uses a fast, lighter cut for draft", () => {
    const args = buildCutArgs({ ...base, draft: true }, "f.filter", "-filter_complex_script");
    expect(after(args, "-preset")).toBe("ultrafast");
    expect(Number(after(args, "-crf"))).toBeGreaterThan(16);
  });
});

describe("draftFps", () => {
  it("halves the frame count at most to 15 fps", () => {
    expect(draftFps(30)).toBe(15);
    expect(draftFps(60)).toBe(15);
  });
  it("never raises the frame rate", () => {
    expect(draftFps(12)).toBe(12);
  });
});
