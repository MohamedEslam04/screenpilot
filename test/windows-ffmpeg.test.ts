import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gdigrabArgs, progressFrame, windowsFfmpegBackend } from "../src/record/backends/windows-ffmpeg.js";

const primary = { name: "\\\\.\\DISPLAY1", x: 0, y: 0, w: 2560, h: 1440 };
const left = { name: "\\\\.\\DISPLAY2", x: -1920, y: 0, w: 1920, h: 1080 };
const all = [primary, left];

const opt = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("gdigrab arguments", () => {
  it("grabs one monitor at its desktop position", () => {
    const args = gdigrabArgs([primary], all, "out.mkv");
    expect(opt(args, "-f")).toBe("gdigrab");
    expect(opt(args, "-framerate")).toBe("30");
    expect(opt(args, "-draw_mouse")).toBe("1");
    expect(opt(args, "-offset_x")).toBe("0");
    expect(opt(args, "-offset_y")).toBe("0");
    expect(opt(args, "-video_size")).toBe("2560x1440");
    expect(opt(args, "-i")).toBe("desktop");
    expect(args.at(-1)).toBe("out.mkv");
  });

  it("uses negative offsets for a monitor left of the primary (offsets are from the primary's top-left)", () => {
    const args = gdigrabArgs([left], all, "out.mkv");
    expect(opt(args, "-offset_x")).toBe("-1920");
    expect(opt(args, "-offset_y")).toBe("0");
    expect(opt(args, "-video_size")).toBe("1920x1080");
  });

  it("grabs the union of several monitors", () => {
    const args = gdigrabArgs(all, all, "out.mkv");
    expect(opt(args, "-offset_x")).toBe("-1920");
    expect(opt(args, "-video_size")).toBe("4480x1440");
  });

  it("encodes H.264 for editing, with fast progress reports", () => {
    const args = gdigrabArgs([primary], all, "out.mkv");
    expect(opt(args, "-c:v")).toBe("libx264");
    expect(opt(args, "-preset")).toBe("veryfast");
    expect(opt(args, "-crf")).toBe("18");
    expect(opt(args, "-pix_fmt")).toBe("yuv420p");
    expect(opt(args, "-stats_period")).toBe("0.1");
    expect(args).not.toContain("-vf");
  });

  it("crops odd sizes to even (yuv420p needs it)", () => {
    const odd = { name: "\\\\.\\DISPLAY3", x: 0, y: 0, w: 1365, h: 767 };
    const args = gdigrabArgs([odd], [odd], "out.mkv");
    expect(opt(args, "-vf")).toBe("crop=1364:766:0:0");
  });

  it("refuses an area outside the desktop", () => {
    expect(() => gdigrabArgs([{ ...left, x: -4000 }], all, "out.mkv")).toThrow(/outside/);
  });
});

// The process lifecycle (progress → startedAt, "q" on stdin → clean exit) with a
// stand-in that records a test pattern, where a real ffmpeg is installed.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const FAKE = fileURLToPath(new URL("./fixtures/fake-ffmpeg.sh", import.meta.url));

describe.skipIf(!hasFfmpeg || process.platform === "win32")("recorder lifecycle", () => {
  it("starts on the first progress line and stops cleanly with q", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wff-"));
    try {
      const rec = windowsFfmpegBackend(FAKE);
      const cap = await rec.prepare([primary], all, () => {});
      expect(cap).toMatchObject({ sourceWidth: 2560, sourceHeight: 1440, inputKind: "gdigrab", sourceName: "desktop" });
      const before = performance.now();
      await rec.start(dir);
      expect(rec.startedAt).toBeGreaterThan(before);
      await new Promise((r) => setTimeout(r, 400));
      const file = await rec.stop();
      expect(file.startsWith(dir) && file.endsWith(".mkv")).toBe(true);
      expect((await stat(file)).size).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("reports ffmpeg's error when it dies before recording", async () => {
    const rec = windowsFfmpegBackend("ffmpeg"); // the real one has no gdigrab here
    await rec.prepare([primary], all, () => {});
    await expect(rec.start(tmpdir())).rejects.toThrow(/ffmpeg stopped before recording/);
  }, 20_000);
});

describe("ffmpeg progress", () => {
  it("finds the frame counter in a stats line", () => {
    expect(progressFrame("frame=    0 fps=0.0 q=0.0 size=       0KiB time=N/A bitrate=N/A speed=N/A")).toBe(0);
    expect(progressFrame("frame=   12 fps= 30 q=23.0 size=     256KiB time=00:00:00.30")).toBe(12);
    expect(progressFrame("Input #0, gdigrab, from 'desktop':")).toBeUndefined();
  });
});
