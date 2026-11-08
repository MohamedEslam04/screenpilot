import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFormats } from "../src/render/formats.js";
import { renderFormats, renderStoryboard } from "../src/render/index.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames is faked: it writes a real little MP4 (grey picture, a tone) as long as the
// composition in <buildDir>/index.html says, at its size and frame rate. ffmpeg (cut, join,
// loudness, extras) is real. Every fake call records the length it rendered.
// The fake chunks carry sound only where a test needs it (encoding audio is the slow part of the join).
const fake = vi.hoisted(() => ({ calls: [] as number[], failOn: 0, cache: "", audio: false }));
vi.mock("../src/util/exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/util/exec.js")>();
  const { readFile: read } = await import("node:fs/promises");
  const { join: pjoin } = await import("node:path");
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: Parameters<typeof actual.run>[2]) => {
      if (!args.some((a) => a.endsWith("hyperframes.mjs"))) return actual.run(cmd, args, opts);
      const html = await read(pjoin(args[args.indexOf("render") + 1]!, "index.html"), "utf8");
      const m = /id="root"[^>]*data-duration="([\d.]+)"[^>]*data-width="(\d+)"[^>]*data-height="(\d+)"[^>]*data-fps="(\d+)"/.exec(html)!;
      const [dur, w, h] = [Number(m[1]), m[2], m[3]];
      const fps = args.includes("--fps") ? args[args.indexOf("--fps") + 1] : m[4];
      fake.calls.push(dur);
      if (fake.failOn === fake.calls.length) throw new Error("hyperframes failed");
      const out = args[args.indexOf("-o") + 1]!;
      await actual.run("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=gray:s=${w}x${h}:r=${fps}:d=${dur}`,
        ...(fake.audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${dur}`] : []),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", String(fps),
        ...(fake.audio ? ["-c:a", "aac", "-ac", "2"] : []),
        "-t", String(dur), out,
      ]);
      return { stdout: "", stderr: "" };
    },
  };
});
vi.mock("../src/brand.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/brand.js")>();
  return { ...actual, cacheHome: () => fake.cache };
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const caption = (at: number, text: string) => ({ at, dur: 3, text });

/** A storyboard over a `seconds` long recording (64x36 at 5 fps, so cuts and fakes are cheap) with captions at 20, 150, 250 and 350 s. */
const recordings = new Map<number, string>();
async function project(seconds = 400, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-render-chunks-"));
  if (!recordings.has(seconds)) recordings.set(seconds, makeVideo(join(dir, `src-${seconds}.mp4`), seconds, { size: "64x36", fps: 5 }));
  await copyFile(recordings.get(seconds)!, join(dir, "rec.mp4"));
  fake.cache = join(dir, "cache");
  const path = join(dir, "demo.json");
  await save(path, { captions: [caption(20, "First"), caption(150, "Second"), caption(250, "Third"), caption(350, "Fourth")], ...extra });
  return path;
}
async function save(path: string, sb: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify({ source: "rec.mp4", output: { width: 64, height: 36, fps: 5 }, ...sb }));
}
async function edit(path: string, change: (sb: Record<string, unknown>) => void): Promise<void> {
  const sb = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(sb);
  await writeFile(path, JSON.stringify(sb));
}

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration,duration_ts", "-of", "json", file], { encoding: "utf8" });
  const s = (JSON.parse(out) as { streams: { codec_type: string; nb_read_frames?: string; duration?: string; duration_ts?: number }[] }).streams;
  const v = s.find((x) => x.codec_type === "video")!;
  const a = s.find((x) => x.codec_type === "audio");
  return { frames: Number(v.nb_read_frames), duration: Number(v.duration), audioSeconds: a ? Number(a.duration_ts) / 48000 : 0 };
}

beforeAll(() => {
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = join(tmpdir(), "sp-render-chunks-extract");
});
beforeEach(() => {
  fake.calls = [];
  fake.failOn = 0;
  fake.audio = false;
});

// Several renders of a 400 s recording per test, with real ffmpeg cuts and joins: 28 to 55 s here, over 120 s on the macOS Intel runner.
describe.skipIf(!hasFfmpeg)("chunked render", { timeout: 600_000 }, () => {
  it("renders a long storyboard in chunks and joins them into one video as long as the plan", async () => {
    fake.audio = true;
    const sb = await project();
    const lines: string[] = [];
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, log: (m) => lines.push(m) });
    expect(fake.calls).toEqual([100, 100, 100, 100]);
    expect(lines).toContain("chunk 1/4 (0-100 s): rendering");
    const p = probe(r.output);
    expect(p.frames).toBe(2000);
    expect(Math.abs(p.audioSeconds - 400)).toBeLessThanOrEqual(0.001);
    // The full composition is back in the build dir (preview, plan.json) after the chunks.
    expect(await readFile(join(r.buildDir, "index.html"), "utf8")).toContain('data-duration="400"');
  });

  it("reuses every unchanged chunk and calls HyperFrames zero times", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 });
    fake.calls = [];
    const lines: string[] = [];
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, log: (m) => lines.push(m) });
    expect(fake.calls).toEqual([]);
    expect(lines.filter((l) => /^chunk \d\/4 \(.*\): unchanged, reusing$/.test(l))).toHaveLength(4);
    expect(probe(r.output).frames).toBe(2000);
  });

  it("re-renders only the chunk whose caption changed", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 });
    fake.calls = [];
    await edit(sb, (s) => ((s.captions as { text: string }[])[1]!.text = "Second, edited"));
    const lines: string[] = [];
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, log: (m) => lines.push(m) });
    expect(fake.calls).toEqual([100]);
    expect(lines).toContain("chunk 2/4 (100-200 s): rendering");
  });

  // Review Focus 4: chunk keys are chunk-relative, so a whole-second shift keeps later chunks.
  it("re-renders only the shifted chunk's own slice when a 2 s hold pushes every later chunk", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 });
    fake.calls = [];
    await edit(sb, (s) => (s.holds = [{ at: 50, dur: 2 }]));
    const lines: string[] = [];
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, log: (m) => lines.push(m) });
    expect(fake.calls).toEqual([102]);
    expect(lines.filter((l) => l.endsWith("unchanged, reusing"))).toEqual([
      "chunk 2/4 (102-202 s): unchanged, reusing",
      "chunk 3/4 (202-302 s): unchanged, reusing",
      "chunk 4/4 (302-402 s): unchanged, reusing",
    ]);
    expect(probe(r.output).frames).toBe(2010);
  });

  it("is off below 300 s of output", async () => {
    const sb = await project(200);
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 50 });
    expect(fake.calls).toEqual([200]);
    expect(existsSync(join(r.buildDir, "chunks"))).toBe(false);
  });

  it("is off with chunks: false (--no-chunks)", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft", chunks: false });
    expect(fake.calls).toEqual([400]);
  });

  it("uses 180 s chunks by default", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft" });
    expect(fake.calls).toEqual([180, 220]);
  });

  it("rejects a chunk length under 10 s", async () => {
    const sb = await project(20);
    await expect(renderStoryboard(sb, { quality: "draft", chunkSeconds: 5 })).rejects.toThrow(/chunk/);
  });

  it("names the output range of a failing chunk and resumes from the finished ones", async () => {
    const sb = await project();
    fake.failOn = 3;
    await expect(renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 })).rejects.toThrow("chunk 3/4 (output 200-300 s) failed: hyperframes failed");
    fake.calls = [];
    fake.failOn = 0;
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 });
    expect(fake.calls).toEqual([100, 100]);
    expect(probe(r.output).frames).toBe(2000);
  });

  it("runs loudness, subtitles and extras once, on the joined file", async () => {
    fake.audio = true;
    const sb = await project(400, { audio: { loudness: {} } });
    const lines: string[] = [];
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, subtitles: ["srt"], also: ["poster"], log: (m) => lines.push(m) });
    expect(fake.calls).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith("loudness:"))).toHaveLength(1);
    expect(r.files.map((f) => f.slice(f.lastIndexOf(".")))).toEqual([".srt", ".png"]);
    expect(r.files.every((f) => existsSync(f))).toBe(true);
    expect(probe(r.output).frames).toBe(2000);
  });

  it("records the render speed once per render, from the seconds really rendered", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, workers: 2 });
    const file = join(fake.cache, "render-speed.json");
    const entries = () => readFile(file, "utf8").then((t) => JSON.parse(t).entries as { outSeconds: number; workers: number }[]);
    expect(await entries()).toMatchObject([{ outSeconds: 400, workers: 2 }]);
    // Everything reused: nothing rendered, nothing to learn from.
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, workers: 2 });
    expect(await entries()).toHaveLength(1);
  });

  it("renders a --from/--to window under 300 s in one piece", async () => {
    const sb = await project();
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 50, window: { from: 100, to: 200 } });
    expect(fake.calls).toEqual([100]);
    expect(r.output.endsWith("demo.part-100-200.mp4")).toBe(true);
  });

  it("chunks a long --from/--to window in window time", async () => {
    const sb = await project();
    const r = await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100, window: { from: 50 } });
    expect(fake.calls).toEqual([100, 100, 150]);
    expect(probe(r.output).frames).toBe(1750);
  });

  it("gives each format its own chunk folder", async () => {
    const sb = await project();
    const rs = await renderFormats(sb, parseFormats("64x36,36x64"), { quality: "draft", chunkSeconds: 100 });
    expect(fake.calls).toHaveLength(8);
    for (const r of rs) {
      expect((await readdir(join(r.buildDir, "chunks", "draft"))).filter((f) => f.endsWith(".mp4"))).toHaveLength(4);
      expect(probe(r.output).frames).toBe(2000);
    }
  });

  it("keeps draft and delivery chunks apart", async () => {
    const sb = await project();
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 });
    await renderStoryboard(sb, { quality: "delivery", chunkSeconds: 100 });
    fake.calls = [];
    await renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 });
    expect(fake.calls).toEqual([]);
  });
});
