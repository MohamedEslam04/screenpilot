import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStoryboard } from "../src/render/index.js";
import { findPausedState, PAUSE_FILE, PAUSED_STATE_FILE, RenderPaused, requestPause } from "../src/render/pause.js";
import { renderSequence } from "../src/sequence/index.js";
import { resumePaused } from "../src/sequence/resume.js";
import { MemoryGuardError } from "../src/util/mem.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames is faked as in render-chunks.test.ts: a real little MP4 as long as the composition
// in <buildDir>/index.html says. `onRender` runs inside a call, so a test can pause mid-render.
const fake = vi.hoisted(() => ({ calls: [] as number[], cache: "", onRender: undefined as undefined | ((n: number) => Promise<void>) }));
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
      await fake.onRender?.(fake.calls.length);
      const out = args[args.indexOf("-o") + 1]!;
      await actual.run("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=gray:s=${w}x${h}:r=${fps}:d=${dur}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", String(fps),
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
const MB = 1024 * 1024;

const recordings = new Map<number, string>();
/** A folder with storyboards over 64x36, 5 fps recordings (cheap to cut and fake). */
async function project(storyboards: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-pause-resume-"));
  fake.cache = join(dir, "cache");
  for (const [name, seconds] of Object.entries(storyboards)) {
    if (!recordings.has(seconds)) recordings.set(seconds, makeVideo(join(dir, `src-${seconds}.mp4`), seconds, { size: "64x36", fps: 5 }));
    await copyFile(recordings.get(seconds)!, join(dir, `${name}.mp4`));
    const captions = [20, 150, 250, 350].filter((t) => t < seconds - 3).map((at) => ({ at, dur: 3, text: `At ${at}` }));
    await writeFile(join(dir, `${name}.json`), JSON.stringify({ source: `${name}.mp4`, output: { width: 64, height: 36, fps: 5 }, captions }));
  }
  return dir;
}
async function sequence(dir: string, parts: string[]): Promise<string> {
  const path = join(dir, "seq.json");
  await writeFile(path, JSON.stringify({ parts: parts.map((p) => ({ storyboard: `${p}.json` })) }));
  return path;
}
/** Pause from "another terminal" while the n-th HyperFrames call runs. */
const pauseDuring = (n: number, path: string) => (fake.onRender = async (call) => void (call === n && (await requestPause({ path }))));

const paused = async (p: Promise<unknown>): Promise<RenderPaused> => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(RenderPaused);
  return err as RenderPaused;
};

beforeAll(() => {
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = join(tmpdir(), "sp-pause-resume-extract");
});
beforeEach(() => {
  fake.calls = [];
  fake.onRender = undefined;
});

describe.skipIf(!hasFfmpeg)("pause and resume", { timeout: 600_000 }, () => {
  it("a sequence finishes the part in progress, stops, and resume reuses every finished part", async () => {
    const dir = await project({ a: 6, b: 6, c: 6 });
    const seq = await sequence(dir, ["a", "b", "c"]);
    pauseDuring(1, seq);
    const err = await paused(renderSequence(seq, { quality: "draft" }));
    expect(fake.calls).toHaveLength(1);
    expect(err.info).toMatchObject({ paused: true, kind: "sequence", path: seq, partsDone: 1, partsTotal: 3 });
    expect(err.info.parts!.map((p) => p.status)).toEqual(["done", "waiting", "waiting"]);
    expect(err.info.resume).toBe(`screenpilot resume ${seq}`);
    // The request is used up; the state says how to carry on.
    expect(existsSync(join(dir, "seq.build", PAUSE_FILE))).toBe(false);
    expect(existsSync(join(dir, "seq.build", PAUSED_STATE_FILE))).toBe(true);

    fake.calls = [];
    fake.onRender = undefined;
    const lines: string[] = [];
    const r = await resumePaused(seq, { log: (m) => lines.push(m) });
    expect(fake.calls).toHaveLength(2);
    expect(lines).toContain(`part 1/3: unchanged, reusing ${join(dir, "seq.build", "part-0", "part.mp4")}`);
    expect(existsSync((r as { output: string }).output)).toBe(true);
    expect(await findPausedState(seq)).toBeUndefined();
  });

  it("does not redo the part in progress from zero: its finished chunks are reused (Review Focus 5)", async () => {
    const dir = await project({ long: 400, short: 6 });
    const seq = await sequence(dir, ["long", "short"]);
    pauseDuring(1, seq);
    const err = await paused(renderSequence(seq, { quality: "draft" }));
    // Stopped after the first 180 s chunk of the long part, not after the whole part.
    expect(fake.calls).toEqual([180]);
    expect(err.info.parts).toEqual([
      { part: 1, status: "in progress", chunks: { done: 1, total: 2 } },
      { part: 2, status: "waiting" },
    ]);

    fake.calls = [];
    fake.onRender = undefined;
    await resumePaused(seq, {});
    expect(fake.calls).toEqual([220, expect.closeTo(6, 1)]);
  });

  it("a long single render stops after the current chunk and resumes from the next one", async () => {
    const dir = await project({ long: 400 });
    const sb = join(dir, "long.json");
    pauseDuring(1, sb);
    const err = await paused(renderStoryboard(sb, { quality: "draft", chunkSeconds: 100 }));
    expect(fake.calls).toEqual([100]);
    expect(err.info).toMatchObject({ paused: true, kind: "render", path: sb, chunks: { done: 1, total: 4 }, buildDir: join(dir, "long.build") });

    fake.calls = [];
    fake.onRender = undefined;
    const r = (await resumePaused(sb, {})) as { output: string };
    // The saved options (draft, 100 s chunks) are used again, so the first chunk is a cache hit.
    expect(fake.calls).toEqual([100, 100, 100]);
    expect(r.output).toBe(join(dir, "long.mp4"));
  });

  it("ignores a .pause left from before the render started", async () => {
    const dir = await project({ a: 6, b: 6 });
    const seq = await sequence(dir, ["a", "b"]);
    await requestPause({ path: seq });
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, "seq.build", PAUSE_FILE), old, old);
    const r = await renderSequence(seq, { quality: "draft" });
    expect(fake.calls).toHaveLength(2);
    expect(existsSync(r.output)).toBe(true);
  });

  it("says when nothing is paused", async () => {
    const dir = await project({ a: 6 });
    const seq = await sequence(dir, ["a"]);
    await expect(resumePaused(seq, {})).rejects.toThrow(/Nothing paused/);
  });

  it("the memory guard fails with the numbers after the timeout and renders nothing", async () => {
    const dir = await project({ a: 6, b: 6 });
    const seq = await sequence(dir, ["a", "b"]);
    const err = await renderSequence(seq, { quality: "draft", minFreeMemMB: 1500, memTimeoutS: 0.05, memPollMs: 5, memReader: async () => 100 * MB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryGuardError);
    expect((err as Error).message).toMatch(/^part 1\/2: not enough free memory: 100 MB available, need 1500 MB/);
    expect(fake.calls).toEqual([]);
  });

  it("the memory guard waits for memory, then renders", async () => {
    const dir = await project({ a: 6 });
    const sb = join(dir, "a.json");
    const values = [100, 200, 4000];
    const lines: string[] = [];
    const r = await renderStoryboard(sb, { quality: "draft", minFreeMemMB: 1500, memPollMs: 5, memReader: async () => (values.shift() ?? 4000) * MB, log: (m) => lines.push(m) });
    expect(existsSync(r.output)).toBe(true);
    expect(lines).toContain("render: waiting for memory: 100 MB available, need 1500 MB (up to 300 s)");
    expect(fake.calls).toHaveLength(1);
  });

  it("reports the peak memory of the render's child processes", async () => {
    const dir = await project({ a: 6, b: 6 });
    const seq = await sequence(dir, ["a", "b"]);
    const r = await renderSequence(seq, { quality: "draft" });
    const single = await renderStoryboard(join(dir, "a.json"), { quality: "draft" });
    if (process.platform === "win32") {
      expect(r.peakRssMB).toBeUndefined();
    } else {
      expect(r.peakRssMB).toEqual(expect.any(Number));
      expect(single.peakRssMB).toEqual(expect.any(Number));
    }
  });
});
