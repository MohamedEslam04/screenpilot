import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStoryboard } from "../src/render/index.js";
import { prepareSequence, renderSequence, validateSequence } from "../src/sequence/index.js";
import { DEFAULT_FIT_MAX, fitLines, fitWarnings } from "../src/storyboard/lint.js";
import { fitClip, synthesizeLines } from "../src/voice/index.js";
import { probeDuration } from "../src/util/media.js";
import { makeVideo } from "./fixtures/video.js";

vi.mock("../src/util/exec.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/util/exec.js")>();
  const { writeFile: write } = await import("node:fs/promises");
  return {
    ...real,
    run: async (cmd: string, args: string[], opts?: Parameters<typeof real.run>[2]) => {
      if (cmd !== process.execPath) return real.run(cmd, args, opts);
      await write(args[args.indexOf("-o") + 1]!, "fake mp4");
      return { stdout: "", stderr: "" };
    },
  };
});
vi.mock("../src/voice/edge.js", async () => ({ edgeProvider: (await import("./fixtures/fake-edge.js")).fakeEdge }));
const { spoken } = await import("./fixtures/fake-edge.js");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpegDescribe = hasFfmpeg ? describe : describe.skip;

describe("fitLines", () => {
  it("a slot runs from a line to the next one, minus the gap; the last line has none", () => {
    const e = fitLines(
      [
        { id: "b", index: 1, at: 5, duration: 2 },
        { id: "a", index: 0, at: 1, duration: 3 },
        { id: "c", index: 2, at: 9, duration: 4 },
      ],
      0.3,
    );
    expect(e).toEqual([
      { id: "a", index: 0, raw: 3, slot: 3.7, needed: 0.811 },
      { id: "b", index: 1, raw: 2, slot: 3.7, needed: 0.541 },
    ]);
  });

  it("reports the speed-up a line needs when it overruns", () => {
    const [a] = fitLines(
      [
        { id: "a", index: 0, at: 0, duration: 5.2 },
        { id: "b", index: 1, at: 4.4, duration: 1 },
      ],
      0.3,
    );
    expect(a).toMatchObject({ raw: 5.2, slot: 4.1, needed: 1.268 });
  });

  it("a line that starts together with the next one has no room at all (needed stays finite)", () => {
    const [a] = fitLines(
      [
        { id: "a", index: 0, at: 2, duration: 1 },
        { id: "b", index: 1, at: 2, duration: 1 },
      ],
      0.3,
    );
    expect(Number.isFinite(a!.needed)).toBe(true);
    expect(a!.needed).toBeGreaterThan(1);
  });
});

describe("fitWarnings", () => {
  const entries = [
    { id: "a", index: 0, raw: 5.2, slot: 4.1, needed: 1.268 },
    { id: "b", index: 1, raw: 2.4, slot: 2.2, needed: 1.091 },
    { id: "c", index: 2, raw: 1, slot: 3, needed: 0.333 },
  ];

  it("warns above the cap only, with raw seconds, slot and the speed-up needed", () => {
    const w = fitWarnings(entries, DEFAULT_FIT_MAX);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^\[narration-fit\]/);
    expect(w[0]).toContain('"a"');
    expect(w[0]).toContain("5.2s");
    expect(w[0]).toContain("4.1s");
    expect(w[0]).toContain("1.27x");
    expect(w[0]).toContain("1.18x");
  });

  it("the cap is configurable, and a line exactly at the cap is fine", () => {
    expect(fitWarnings(entries, 1.3)).toEqual([]);
    expect(fitWarnings(entries, 1.268)).toEqual([]);
    expect(fitWarnings(entries, 1.05)).toHaveLength(2);
  });

  it("says when the line was already sped up to the cap and still overruns", () => {
    expect(fitWarnings([{ ...entries[0]!, applied: 1.18 }], 1.18)[0]).toMatch(/even sped up/);
  });
});

ffmpegDescribe("fitClip", () => {
  it("stretches a clip from its raw file, caches it by factor and never stretches twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-fit-"));
    const [clip] = await synthesizeLines("edge", [{ text: "x".repeat(30), voice: "v", rate: "+0%" }], dir);
    expect(clip!.duration).toBeGreaterThan(2.9);
    const fitted = await fitClip(clip!, 1.25);
    expect(fitted.file).not.toBe(clip!.file);
    expect(fitted.file).toMatch(/\.x1\.250\.mp3$/);
    expect(fitted.duration).toBeGreaterThan(2.3);
    expect(fitted.duration).toBeLessThan(2.6);
    expect(await probeDuration(fitted.file)).toBeCloseTo(fitted.duration, 1);
    const before = (await stat(fitted.file)).mtimeMs;
    const again = await fitClip(clip!, 1.25);
    expect(again.file).toBe(fitted.file);
    expect((await stat(fitted.file)).mtimeMs).toBe(before);
    // The raw clip is untouched.
    expect(await probeDuration(clip!.file)).toBeCloseTo(clip!.duration, 1);
  });
});

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

async function fixture(lines: { at: number; text: string; id?: string }[], extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-fit-render-"));
  makeVideo(join(dir, "rec.mp4"), 8);
  await writeJson(join(dir, "demo.json"), { source: "rec.mp4", output: { width: 320, height: 180, fps: 10 }, narration: lines, ...extra });
  return dir;
}

beforeAll(() => {
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = join(tmpdir(), "sp-fit-extract");
});
beforeEach(() => {
  spoken.length = 0;
});

// "x" * n is n * 0.1 s long. Slot of the first line: 2.5 - 0.3 = 2.2 s.
const over = [
  { at: 0, text: "a".repeat(30), id: "long" }, // 3.0 s: needs 1.364x
  { at: 2.5, text: "b".repeat(10), id: "ok" }, // 1.0 s, last line
];
const slight = [
  { at: 0, text: "a".repeat(24), id: "slight" }, // 2.4 s: needs 1.091x
  { at: 2.5, text: "b".repeat(10), id: "ok" },
];

ffmpegDescribe("slot-fit in render", () => {
  it("reports {id, raw, slot, needed} and warns for a line above the default cap", async () => {
    const dir = await fixture(over);
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    const e = r.fit.find((x) => x.id === "long")!;
    expect(e.raw).toBeGreaterThan(2.9);
    expect(e.slot).toBe(2.2);
    expect(e.needed).toBeGreaterThan(1.3);
    expect(r.warnings.filter((w) => w.startsWith("[narration-fit]"))).toHaveLength(1);
  });

  it("a storyboard whose lines fit gets no new warning and no stretched clip", async () => {
    const dir = await fixture([
      { at: 0, text: "a".repeat(10) },
      { at: 3, text: "b".repeat(10) },
    ]);
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    expect(r.warnings.filter((w) => w.includes("narration-fit"))).toEqual([]);
    expect((await readdir(join(dir, ".screenpilot-cache", "voice"))).filter((f) => f.includes(".x"))).toEqual([]);
  });

  it("lint.off turns the warning off", async () => {
    const dir = await fixture(over, { lint: { off: ["narration-fit"] } });
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    expect(r.warnings.filter((w) => w.includes("narration-fit"))).toEqual([]);
  });

  it("--strict-fit fails above the cap, listing the line", async () => {
    const dir = await fixture(over);
    await expect(renderStoryboard(join(dir, "demo.json"), { quality: "draft", fit: { strict: true } })).rejects.toThrow(/long.*1\.3\d?x.*1\.18x/s);
  });

  it("--strict-fit passes when the cap is raised past the need (configurable)", async () => {
    const dir = await fixture(over);
    await expect(renderStoryboard(join(dir, "demo.json"), { quality: "draft", fit: { strict: true, max: 1.5 } })).resolves.toBeTruthy();
  });

  it("the cap can be set in the storyboard (voice.fit.max)", async () => {
    const dir = await fixture(over, { voice: { fit: { max: 1.5 } } });
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", fit: { strict: true } });
    expect(r.warnings.filter((w) => w.includes("narration-fit"))).toEqual([]);
  });

  it("auto-fit speeds a line up to its slot, records it in the voice cache and does not stretch twice", async () => {
    const dir = await fixture(slight);
    const first = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", fit: { auto: true } });
    const voiceDir = join(dir, ".screenpilot-cache", "voice");
    const stretched = (await readdir(voiceDir)).filter((f) => /\.x1\.\d{3}\.mp3$/.test(f));
    expect(stretched).toHaveLength(1);
    const e = first.fit.find((x) => x.id === "slight")!;
    expect(e.applied).toBeGreaterThan(1.09);
    expect(e.applied).toBeLessThanOrEqual(1.18);
    expect(first.warnings.filter((w) => w.includes("narration-fit"))).toEqual([]);
    // The clip the composition uses now fits: no automatic freeze for it.
    expect(first.autoHolds).toEqual([]);

    const mtime = (await stat(join(voiceDir, stretched[0]!))).mtimeMs;
    const second = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", fit: { auto: true } });
    expect((await readdir(voiceDir)).filter((f) => /\.x1\.\d{3}\.mp3$/.test(f))).toEqual(stretched);
    expect((await stat(join(voiceDir, stretched[0]!))).mtimeMs).toBe(mtime);
    expect(second.fit.find((x) => x.id === "slight")!.applied).toBe(e.applied);
    expect(spoken).toHaveLength(2); // two lines synthesized once, nothing again
  });

  it("auto-fit never goes past the cap: a line that needs more is sped up to the cap and still reported", async () => {
    const dir = await fixture(over);
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", fit: { auto: true } });
    expect(r.fit.find((x) => x.id === "long")!.applied).toBe(1.18);
    expect(r.warnings.filter((w) => w.includes("narration-fit"))[0]).toMatch(/even sped up/);
  });

  it("without the option nothing is sped up", async () => {
    const dir = await fixture(slight);
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    expect(r.fit.find((x) => x.id === "slight")!.applied).toBeUndefined();
  });
});

ffmpegDescribe("slot-fit in sequences", () => {
  async function seq(): Promise<string> {
    const dir = await fixture(over);
    await writeJson(join(dir, "seq.json"), { parts: [{ storyboard: "demo.json" }] });
    return dir;
  }

  it("sequence_validate --fit measures cached clips only, and says what it could not measure", async () => {
    const dir = await seq();
    const cold = await validateSequence(join(dir, "seq.json"), { fit: true });
    expect(cold.warnings.join("\n")).toMatch(/2 line\(s\) have no cached clip/);
    expect(cold.warnings.filter((w) => w.includes("[narration-fit]") && w.includes("long"))).toEqual([]);
    expect(spoken).toEqual([]); // validating never synthesizes

    await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    const warm = await validateSequence(join(dir, "seq.json"), { fit: true });
    expect(warm.warnings.filter((w) => w.includes("[narration-fit]") && w.includes('"long"'))).toHaveLength(1);
    expect(warm.warnings.join("\n")).toMatch(/parts\[0\] \(demo\.json\)/);
    expect(warm.fit?.[0]).toMatchObject({ id: "long" });
    // The cap is configurable here too.
    expect((await validateSequence(join(dir, "seq.json"), { fit: true, fitMax: 1.5 })).warnings.filter((w) => w.includes('"long"'))).toEqual([]);
    // Without --fit nothing is measured.
    expect((await validateSequence(join(dir, "seq.json"))).warnings.filter((w) => w.includes("narration-fit"))).toEqual([]);
  });

  it("a part's cache key includes the fit options, so a fitted render is not served from an unfitted one", async () => {
    const dir = await seq();
    const plain = await prepareSequence(join(dir, "seq.json"));
    const fit = await prepareSequence(join(dir, "seq.json"), { fit: { auto: true } });
    expect(fit.parts[0]!.key).not.toBe(plain.parts[0]!.key);
    expect((await prepareSequence(join(dir, "seq.json"), { fit: { auto: true } })).parts[0]!.key).toBe(fit.parts[0]!.key);
  });

  it("strict-fit fails the sequence render naming the part", async () => {
    const dir = await seq();
    await expect(renderSequence(join(dir, "seq.json"), { quality: "draft", fit: { strict: true } })).rejects.toThrow(/long/);
    expect(existsSync(join(dir, "seq.mp4"))).toBe(false);
  });
});
