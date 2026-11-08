import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCutArgs } from "../src/render/cut.js";
import { draftFps } from "../src/render/draft.js";
import { renderStoryboard } from "../src/render/index.js";
import { estimateSeconds, formatDuration, recordSpeed } from "../src/render/speed.js";
import { autoWorkers } from "../src/render/workers.js";
import { makeTimer } from "../src/util/timing.js";
import { makeVideo } from "./fixtures/video.js";

// The integration tests at the end replace only the HyperFrames call; ffmpeg steps run for real.
const fake = vi.hoisted(() => ({ fail: false, calls: 0, cache: "" }));
vi.mock("../src/util/exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/util/exec.js")>();
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: Parameters<typeof actual.run>[2]) => {
      if (args.some((a) => a.endsWith("hyperframes.mjs"))) {
        fake.calls++;
        if (fake.fail) throw new Error("hyperframes failed");
        return { stdout: "", stderr: "" };
      }
      return actual.run(cmd, args, opts);
    },
  };
});
vi.mock("../src/brand.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/brand.js")>();
  return { ...actual, cacheHome: () => fake.cache };
});

const GB = 1024 ** 3;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

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

async function speedFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "sp-speed-")), "nested", "render-speed.json");
}
const entry = (quality: string, outSeconds: number, wallSeconds: number) => ({ quality, workers: 4, outSeconds, wallSeconds });

describe("estimateSeconds", () => {
  it("is undefined without a file, with an empty file and with a corrupt file", async () => {
    const file = await speedFile();
    expect(await estimateSeconds(file, "delivery", 600)).toBeUndefined();
    await recordSpeed(file, entry("delivery", 100, 100));
    await writeFile(file, "");
    expect(await estimateSeconds(file, "delivery", 600)).toBeUndefined();
    await writeFile(file, "{not json");
    expect(await estimateSeconds(file, "delivery", 600)).toBeUndefined();
    await writeFile(file, JSON.stringify({ entries: "nope" }));
    expect(await estimateSeconds(file, "delivery", 600)).toBeUndefined();
  });

  it("uses the median speed of that quality only", async () => {
    const file = await speedFile();
    // speeds (video seconds per wall second): 2, 1, 0.5 -> median 1
    await recordSpeed(file, entry("delivery", 200, 100));
    await recordSpeed(file, entry("delivery", 100, 100));
    await recordSpeed(file, entry("delivery", 50, 100));
    await recordSpeed(file, entry("draft", 1000, 100));
    expect(await estimateSeconds(file, "delivery", 600)).toBe(600);
    expect(await estimateSeconds(file, "draft", 600)).toBe(60);
    expect(await estimateSeconds(file, "looks", 600)).toBeUndefined();
  });

  it("keeps the last 5 entries per quality", async () => {
    const file = await speedFile();
    for (let i = 1; i <= 7; i++) await recordSpeed(file, entry("delivery", i, 1));
    await recordSpeed(file, entry("draft", 9, 1));
    const stored = JSON.parse(await readFile(file, "utf8")).entries as { quality: string; outSeconds: number }[];
    expect(stored.filter((e) => e.quality === "delivery").map((e) => e.outSeconds)).toEqual([3, 4, 5, 6, 7]);
    expect(stored.filter((e) => e.quality === "draft")).toHaveLength(1);
  });

  it("starts over when the file is corrupt, and ignores impossible entries", async () => {
    const file = await speedFile();
    await recordSpeed(file, entry("delivery", 10, 10));
    await writeFile(file, "garbage");
    await recordSpeed(file, entry("delivery", 20, 10));
    await recordSpeed(file, entry("delivery", 0, 10));
    await recordSpeed(file, entry("delivery", 10, 0));
    expect(await estimateSeconds(file, "delivery", 100)).toBe(50);
  });
});

describe("formatDuration", () => {
  it("writes seconds, minutes, and hours with minutes", () => {
    expect(formatDuration(40)).toBe("40 s");
    expect(formatDuration(3300)).toBe("55 min");
    expect(formatDuration(4500)).toBe("1 h 15 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(3599)).toBe("1 h");
  });
});

describe.skipIf(!hasFfmpeg)("renderStoryboard speed records", () => {
  async function project(seconds = 6): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sp-render-speed-"));
    makeVideo(join(dir, "rec.mp4"), seconds);
    await writeFile(join(dir, "storyboard.json"), JSON.stringify({ source: "rec.mp4", output: { width: 320, height: 180, fps: 30 } }));
    fake.cache = join(dir, "cache");
    return join(dir, "storyboard.json");
  }
  const stored = async () => JSON.parse(await readFile(join(fake.cache, "render-speed.json"), "utf8")).entries as { quality: string; workers: number; outSeconds: number }[];

  beforeEach(() => {
    fake.fail = false;
    fake.calls = 0;
  });

  it("writes one entry after a successful render and prints no estimate without history", async () => {
    const sb = await project();
    const lines: string[] = [];
    await renderStoryboard(sb, { quality: "draft", workers: 3, log: (m) => lines.push(m) });
    expect(fake.calls).toBe(1);
    const entries = await stored();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ quality: "draft", workers: 3 });
    expect(entries[0]!.outSeconds).toBeGreaterThan(1);
    expect(lines.some((l) => l.includes("estimated"))).toBe(false);
  });

  it("does not remember very short renders (start-up dominates)", async () => {
    const sb = await project(2);
    await renderStoryboard(sb, { quality: "draft" });
    await expect(readFile(join(fake.cache, "render-speed.json"), "utf8")).rejects.toThrow();
  });

  it("writes nothing when the render throws", async () => {
    const sb = await project();
    fake.fail = true;
    await expect(renderStoryboard(sb, { quality: "draft" })).rejects.toThrow("hyperframes failed");
    await expect(readFile(join(fake.cache, "render-speed.json"), "utf8")).rejects.toThrow();
  });

  it("logs an estimate of 2 minutes or more from earlier renders of the same quality", async () => {
    const sb = await project();
    // 0.002 video seconds per wall second: about 3000 s for a 6 s video
    await recordSpeed(join(fake.cache, "render-speed.json"), entry("delivery", 1, 500));
    const lines: string[] = [];
    await renderStoryboard(sb, { quality: "delivery", log: (m) => lines.push(m) });
    const line = lines.find((l) => l.includes("estimated"));
    expect(line).toMatch(/estimated ~\d+ min/);
    expect(line).toContain("-q draft");
    expect(line).toContain("--workers max");
  });

  it("prints no estimate under 2 minutes", async () => {
    const sb = await project();
    await recordSpeed(join(fake.cache, "render-speed.json"), entry("delivery", 1, 1));
    const lines: string[] = [];
    await renderStoryboard(sb, { quality: "delivery", log: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes("estimated"))).toBe(false);
  });

  it("survives a corrupt speed file", async () => {
    const sb = await project();
    await mkdir(fake.cache, { recursive: true });
    await writeFile(join(fake.cache, "render-speed.json"), "{{{");
    await renderStoryboard(sb, { quality: "draft" });
    expect(await stored()).toHaveLength(1);
  });
});
