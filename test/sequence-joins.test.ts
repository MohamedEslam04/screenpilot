import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderPaused, requestPause } from "../src/render/pause.js";
import { readTimeline } from "../src/render/timeline.js";
import { loadStyle } from "../src/storyboard/load.js";
import { expandJoins, joinsPath, parseJoins, parseJoinTransition, renderJoins } from "../src/sequence/joins.js";
import { resumePaused } from "../src/sequence/resume.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames is faked as in pause-resume.test.ts: a real little MP4 as long as the composition in
// <buildDir>/index.html says, so durations add up as in a real render. ffmpeg and ffprobe are real.
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

/** Storyboards a..d (64x36, 5 fps, 4 s, an intro card named after them) and three groups: g1 = a+b, g2 = c, g3 = d. */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-joins-"));
  fake.cache = join(dir, "cache");
  const rec = makeVideo(join(dir, "rec.mp4"), 4, { size: "64x36", fps: 5 });
  for (const name of ["a", "b", "c", "d"]) {
    await copyFile(rec, join(dir, `${name}.mp4`));
    await writeFile(join(dir, `${name}.json`), JSON.stringify({ source: `${name}.mp4`, output: { width: 64, height: 36, fps: 5 }, intro: { title: name.toUpperCase(), dur: 1 } }));
  }
  const group = (parts: string[]) => JSON.stringify({ parts: parts.map((p) => ({ storyboard: `${p}.json` })) });
  await writeFile(join(dir, "g1.json"), group(["a", "b"]));
  await writeFile(join(dir, "g2.json"), group(["c"]));
  await writeFile(join(dir, "g3.json"), group(["d"]));
  return dir;
}

beforeAll(() => {
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = join(tmpdir(), "sp-joins-extract");
});
beforeEach(() => {
  fake.calls = [];
  fake.onRender = undefined;
});

describe("parseJoins / expandJoins", () => {
  it("reads name=a+b pairs in order", () => {
    expect(parseJoins("setup=g1.json+g2.json, operations=g3.json,full=setup+operations")).toEqual({
      setup: ["g1.json", "g2.json"],
      operations: ["g3.json"],
      full: ["setup", "operations"],
    });
  });

  it("refuses a bad spec with the reason", () => {
    expect(() => parseJoins("")).toThrow(/--joins/);
    expect(() => parseJoins("setup")).toThrow(/name=a\+b/);
    expect(() => parseJoins("a/b=g1.json")).toThrow(/name "a\/b"/);
    expect(() => parseJoins("x=g1.json,x=g2.json")).toThrow(/"x" twice/);
    expect(() => parseJoins("x=")).toThrow(/no sequence/);
  });

  it("reads the transition as type[:seconds]", () => {
    expect(parseJoinTransition("fade-black:0.6")).toEqual({ type: "fade-black", dur: 0.6 });
    expect(parseJoinTransition("crossfade")).toEqual({ type: "crossfade", dur: 0.5 });
    expect(() => parseJoinTransition("dissolve:1")).toThrow(/fade-black/);
    expect(() => parseJoinTransition("crossfade:-1")).toThrow(/type\[:seconds\]/);
  });

  it("expands names into groups (sequence files, resolved) and finds loops", () => {
    expect(expandJoins({ setup: ["g1.json", "g2.json"], operations: ["g3.json"], full: ["setup", "operations"] }, "/p")).toEqual({
      setup: ["/p/g1.json", "/p/g2.json"],
      operations: ["/p/g3.json"],
      full: ["/p/g1.json", "/p/g2.json", "/p/g3.json"],
    });
    expect(() => expandJoins({ a: ["b"], b: ["a"] }, "/p")).toThrow(/a → b → a/);
  });
});

describe.skipIf(!hasFfmpeg)("renderJoins", { timeout: 600_000 }, () => {
  it("renders every group once, joins each video with the transition, and writes its timeline", async () => {
    const dir = await project();
    const lines: string[] = [];
    const r = await renderJoins(
      { joins: { setup: ["g1.json", "g2.json"], operations: ["g3.json"], full: ["setup", "operations"] }, transition: { type: "fade-black", dur: 0.6 }, baseDir: dir },
      { quality: "draft", log: (m) => lines.push(m) },
    );
    // a, b, c and d each rendered once, although g1..g3 are used by two joined videos.
    expect(fake.calls).toHaveLength(4);
    expect(r.groups.map((g) => [g.sequence, g.rendered])).toEqual([
      [join(dir, "g1.json"), true],
      [join(dir, "g2.json"), true],
      [join(dir, "g3.json"), true],
    ]);
    expect(r.joins.map((j) => [j.name, j.output, j.timeline])).toEqual([
      ["setup", join(dir, "setup.mp4"), join(dir, "setup.timeline.json")],
      ["operations", join(dir, "operations.mp4"), join(dir, "operations.timeline.json")],
      ["full", join(dir, "full.mp4"), join(dir, "full.timeline.json")],
    ]);
    // full only reuses the groups setup and operations rendered.
    expect(r.joins[2]!.parts.every((p) => p.cached)).toBe(true);
    expect(lines.filter((l) => /unchanged, reusing .*group-g1/.test(l))).toHaveLength(1);

    const [g1, g2, g3] = r.joins[2]!.parts.map((p) => p.duration) as [number, number, number];
    // g1 = a (intro 1 s + 4 s) + b (4 s); g2 and g3 have their own intro.
    expect(g1).toBeCloseTo(9, 1);
    expect(g2).toBeCloseTo(5, 1);
    // Durations: the sum of the groups minus one dur per join.
    expect(r.joins[0]!.duration).toBeCloseTo(g1 + g2 - 0.6, 1);
    expect(r.joins[1]!.duration).toBeCloseTo(g3, 1);
    expect(r.joins[2]!.duration).toBeCloseTo(g1 + g2 + g3 - 1.2, 1);
    for (const j of r.joins) expect(existsSync(j.output)).toBe(true);

    // Timeline offsets: each group starts where the previous ends minus the overlap.
    const tl = await readTimeline(r.joins[2]!.timeline);
    expect(tl.items.filter((i) => i.kind === "card").map((i) => [i.text, i.part])).toEqual([
      ["A", 0],
      ["C", 1],
      ["D", 2],
    ]);
    const starts = tl.items.filter((i) => i.kind === "card").map((i) => i.start);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(g1 - 0.6, 2);
    expect(starts[2]).toBeCloseTo(g1 + g2 - 1.2, 2);
    expect(tl.duration).toBeCloseTo(r.joins[2]!.duration, 1);

    // Nothing changed: the next call renders nothing.
    fake.calls = [];
    const again = await renderJoins({ joins: { setup: ["g1.json", "g2.json"] }, transition: { type: "fade-black", dur: 0.6 }, baseDir: dir }, { quality: "draft" });
    expect(fake.calls).toEqual([]);
    expect(again.groups.every((g) => !g.rendered)).toBe(true);
  });

  it("names outputs after the style, pauses between parts and resumes from the cached ones", async () => {
    const dir = await project();
    await writeFile(join(dir, "dark.json"), JSON.stringify({ theme: { background: "#000000" } }));
    const style = await loadStyle(join(dir, "dark.json"));
    const spec = { joins: { setup: ["g1.json", "g2.json"], full: ["setup", "g3.json"] }, transition: { type: "crossfade" as const, dur: 0.5 }, baseDir: dir };
    const path = joinsPath(dir);
    fake.onRender = async (call) => void (call === 1 && (await requestPause({ path })));
    const err = await renderJoins(spec, { quality: "draft", style }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderPaused);
    const info = (err as RenderPaused).info;
    expect(info).toMatchObject({ paused: true, kind: "joins", path, join: "setup", buildDir: join(dir, "joins.dark.build"), resume: `screenpilot resume ${path}` });
    expect(fake.calls).toHaveLength(1);

    fake.calls = [];
    fake.onRender = undefined;
    const r = (await resumePaused(path, {})) as Awaited<ReturnType<typeof renderJoins>>;
    // a was finished before the pause: only b, c and d render now.
    expect(fake.calls).toHaveLength(3);
    expect(r.joins.map((j) => j.output)).toEqual([join(dir, "setup.dark.mp4"), join(dir, "full.dark.mp4")]);
    for (const j of r.joins) expect(existsSync(j.output)).toBe(true);
  });
});
