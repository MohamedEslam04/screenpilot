import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderStoryboard } from "../src/render/index.js";
import { readTimeline } from "../src/render/timeline.js";
import { renderSequence } from "../src/sequence/index.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames (a headless Chrome render) is faked: it writes a 1 s video to the file passed with -o. ffmpeg and ffprobe are real.
vi.mock("../src/util/exec.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/util/exec.js")>();
  return {
    ...real,
    run: async (cmd: string, args: string[], opts?: Parameters<typeof real.run>[2]) => {
      if (cmd !== process.execPath) return real.run(cmd, args, opts);
      return real.run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=1:r=10", "-pix_fmt", "yuv420p", args[args.indexOf("-o") + 1]!]);
    },
  };
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpegIt = hasFfmpeg ? it : it.skip;

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

/** Two storyboards in folders `a` and `b`, each with ready-made narration audio (no voice is synthesized). */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sp-seq-timeline-"));
  await mkdir(join(dir, "a"), { recursive: true });
  await mkdir(join(dir, "b"), { recursive: true });
  makeVideo(join(dir, "a/rec.mp4"), 3);
  makeVideo(join(dir, "b/rec.mp4"), 2);
  for (const f of ["a/one.wav", "b/one.wav"]) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8", join(dir, f)]);
  }
  await writeJson(join(dir, "a/demo.json"), {
    source: "rec.mp4",
    intro: { title: "A", dur: 1 },
    narration: [
      { at: 0.5, text: "A one", audio: "one.wav" },
      { at: 1.8, text: "A two", audio: "one.wav", id: "closing" },
    ],
  });
  await writeJson(join(dir, "b/other.json"), { source: "rec.mp4", narration: [{ at: 0.2, text: "B one", audio: "one.wav" }] });
  await writeJson(join(dir, "seq.json"), {
    parts: [{ storyboard: "a/demo.json" }, { storyboard: "b/other.json", transition: { type: "crossfade", dur: 0.5 } }],
  });
  return dir;
}

describe("timeline.json from render", () => {
  ffmpegIt("is written next to the video, with the line ids and the intro, and is not listed among the subtitle files", async () => {
    const dir = await fixture();
    const r = await renderStoryboard(join(dir, "a/demo.json"), { output: join(dir, "out/demo.mp4"), quality: "draft", history: false });
    expect(r.timelineFile).toBe(join(dir, "out/demo.timeline.json"));
    expect(r.files).toEqual([]);
    const tl = await readTimeline(r.timelineFile);
    // The fake render makes a 1 s file, and the timeline says what the file is.
    expect(tl.duration).toBeCloseTo(1, 1);
    expect(tl.items.map((i) => [i.kind, i.id, i.start, i.end, i.text])).toEqual([
      ["card", undefined, 0, 1, "A"],
      ["narration", "0", 1.5, 2.3, "A one"],
      ["narration", "closing", 2.8, 3.6, "A two"],
    ]);
  }, 60_000);
});

describe("timeline.json from sequence_render", () => {
  ffmpegIt("composes the part timelines across the transition, with part and chapter", async () => {
    const dir = await fixture();
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(r.timeline).toBe(join(dir, "seq.timeline.json"));
    const tl = await readTimeline(r.timeline);
    // Each fake part is 1 s; the crossfade overlaps 0.5 s, so part 2 starts at 0.5 and the video is 1.5 s.
    expect(tl.duration).toBeGreaterThan(1.5 - 0.1);
    expect(tl.duration).toBeLessThan(1.5 + 0.1);
    // (The fake render makes the files shorter than their plans, so a part's later lines run past its end; only the offsets matter here.)
    expect(tl.items.map((i) => [i.text, i.id, i.part, i.chapter, i.start])).toEqual([
      ["A", undefined, 0, "a", 0],
      ["B one", "0", 1, "b", 0.7],
      ["A one", "0", 0, "a", 1.5],
      ["A two", "closing", 0, "a", 2.8],
    ]);
  }, 60_000);

  ffmpegIt("a cached part still contributes its timeline (stored with the part), and a part without one is rendered again", async () => {
    const dir = await fixture();
    const first = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    const before = await readFile(first.timeline, "utf8");
    expect(existsSync(join(dir, "seq.build/part-0/part.timeline.json"))).toBe(true);

    const second = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(second.parts.map((p) => p.cached)).toEqual([true, true]);
    expect(await readFile(second.timeline, "utf8")).toBe(before);

    // A part cached before timelines existed has none: it is rendered again, not skipped.
    await rm(join(dir, "seq.build/part-1/part.timeline.json"));
    const third = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(third.parts.map((p) => p.cached)).toEqual([true, false]);
    expect(await readFile(third.timeline, "utf8")).toBe(before);
  }, 120_000);

  ffmpegIt("a stale part timeline is an error that names the file", async () => {
    const dir = await fixture();
    await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    const file = join(dir, "seq.build/part-0/part.timeline.json");
    const tl = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...tl, duration: 12 }));
    await expect(renderSequence(join(dir, "seq.json"), { quality: "draft" })).rejects.toThrow(file);
  }, 120_000);

  ffmpegIt("joins nested sequences and finished videos, using a video's own timeline file when it has a fresh one", async () => {
    const dir = await fixture();
    makeVideo(join(dir, "c.mp4"), 2);
    await writeJson(join(dir, "c.timeline.json"), {
      version: 1,
      duration: 2,
      items: [{ kind: "narration", id: "x", start: 0.5, end: 1, text: "From the video" }],
    });
    await writeJson(join(dir, "inner.json"), { parts: [{ storyboard: "a/demo.json" }, { storyboard: "b/other.json", transition: { type: "crossfade", dur: 0.5 } }] });
    await writeJson(join(dir, "outer.json"), { parts: [{ sequence: "inner.json" }, { video: "c.mp4", transition: { type: "fade-black", dur: 0.4 } }] });
    const r = await renderSequence(join(dir, "outer.json"), { quality: "draft" });
    const tl = await readTimeline(r.timeline);
    // inner is 1.5 s; c starts at 1.5 - 0.4 = 1.1.
    expect(tl.items.map((i) => [i.text, i.part, i.chapter]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ["A", 0, "a"],
      ["A one", 0, "a"],
      ["A two", 0, "a"],
      ["B one", 0, "b"],
      ["From the video", 1, undefined],
    ]);
    const last = tl.items.find((i) => i.text === "From the video")!;
    expect(last.start).toBeGreaterThan(1.6 - 0.1);
    expect(last.start).toBeLessThan(1.6 + 0.1);
  }, 120_000);
});
