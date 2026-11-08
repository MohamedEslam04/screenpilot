import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildConcatFilter, concatParts, probePart } from "../src/sequence/concat.js";
import { prepareSequence, renderSequence, validateSequence } from "../src/sequence/index.js";
import { sequenceJsonSchema, SequenceSchema } from "../src/sequence/schema.js";
import { prepareBuild } from "../src/render/index.js";
import { loadStyle, StoryboardError } from "../src/storyboard/load.js";
import { probeVideo } from "../src/util/media.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames (a headless Chrome render) is faked: it writes a small real video to the file passed with -o. ffmpeg and ffprobe are real.
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

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sp-sequence-"));
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

describe("sequence schema", () => {
  it("needs at least one part", () => {
    expect(SequenceSchema.safeParse({ parts: [] }).success).toBe(false);
    expect(SequenceSchema.parse({ parts: [{ storyboard: "a.json" }] })).toMatchObject({ version: 1 });
  });

  it("has a JSON schema", () => {
    const s = sequenceJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["parts", "output"]));
  });
});

describe("prepareSequence", () => {
  async function fixture() {
    const dir = await tempDir();
    makeVideo(join(dir, "rec.mp4"), 2);
    await mkdir(join(dir, "feature"), { recursive: true });
    makeVideo(join(dir, "feature/rec.mp4"), 1);
    await writeJson(join(dir, "demo.json"), {
      source: "rec.mp4",
      events: "events.jsonl",
      output: { width: 1280, height: 720, fps: 25 },
      intro: { title: "Demo" },
      outro: { title: "Thanks" },
      overlays: [{ src: "logo.png", x: 0.8, y: 0.05, w: 0.15, h: 0.1 }],
    });
    await writeJson(join(dir, "feature/feature.json"), {
      source: "rec.mp4",
      output: { width: 1080, height: 1920, fps: 60 },
      intro: { title: "Feature" },
      outro: { title: "Feature end" },
    });
    await writeJson(join(dir, "seq.json"), {
      parts: [{ storyboard: "demo.json" }, { storyboard: "feature/feature.json" }, { storyboard: "demo.json" }],
    });
    return dir;
  }

  it("derives one storyboard per part: shared output, intro first, outro last, absolute paths", async () => {
    const dir = await fixture();
    const before = await readFile(join(dir, "demo.json"), "utf8");
    const p = await prepareSequence(join(dir, "seq.json"));
    expect(p.buildDir).toBe(join(dir, "seq.build"));
    expect(p.output).toEqual({ width: 1280, height: 720, fps: 25 });
    expect(p.parts.map((x) => x.dir)).toEqual([0, 1, 2].map((i) => join(dir, "seq.build", `part-${i}`)));

    const derived = await Promise.all(p.parts.map(async (x) => JSON.parse(await readFile(x.storyboard, "utf8"))));
    expect(derived.map((d) => d.output)).toEqual(Array(3).fill({ width: 1280, height: 720, fps: 25 }));
    expect(derived.map((d) => d.intro?.title)).toEqual(["Demo", undefined, undefined]);
    expect(derived.map((d) => d.outro?.title)).toEqual([undefined, undefined, "Thanks"]);
    expect(derived[1].source).toBe(join(dir, "feature/rec.mp4"));
    expect(derived[0].events).toBe(join(dir, "events.jsonl"));
    expect(derived[0].overlays[0].src).toBe(join(dir, "logo.png"));
    expect(p.parts[1]!.cacheDir).toBe(join(dir, "feature", ".screenpilot-cache"));
    // The user's files are untouched.
    expect(await readFile(join(dir, "demo.json"), "utf8")).toBe(before);
  });

  it("makes the paths of narration audio, sound effects and custom sounds absolute too, so a part built in seq.build finds them", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "demo.json"), {
      source: "rec.mp4",
      narration: [{ at: 0.5, text: "hi", audio: "voice/one.mp3" }, { at: 1, text: "plain" }],
      sfx: [{ at: 1, src: "sounds/pop.wav" }, { at: 1.2, src: "builtin:ding" }],
      sounds: { clicks: "sounds/tick.wav", typing: "key", cards: true },
    });
    const p = await prepareSequence(join(dir, "seq.json"));
    const d = JSON.parse(await readFile(p.parts[0]!.storyboard, "utf8"));
    expect(d.narration[0].audio).toBe(join(dir, "voice/one.mp3"));
    expect(d.narration[1].audio).toBeUndefined();
    expect(d.sfx.map((x: { src: string }) => x.src)).toEqual([join(dir, "sounds/pop.wav"), "builtin:ding"]);
    expect(d.sounds).toMatchObject({ clicks: join(dir, "sounds/tick.wav"), typing: "key", cards: true });
  });

  it("rebuilds a part when one of its sound files changes", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "tick.wav"), "a");
    await writeJson(join(dir, "demo.json"), { source: "rec.mp4", sounds: { clicks: "tick.wav" } });
    const a = await prepareSequence(join(dir, "seq.json"));
    await writeFile(join(dir, "tick.wav"), "bbbb");
    const b = await prepareSequence(join(dir, "seq.json"));
    expect(b.parts[0]!.key).not.toBe(a.parts[0]!.key);
  });

  it("lets the sequence override the output", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "seq.json"), { output: { fps: 30 }, parts: [{ storyboard: "feature/feature.json" }] });
    const p = await prepareSequence(join(dir, "seq.json"));
    expect(p.output).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("keys each part on its storyboard and its source file", async () => {
    const dir = await fixture();
    const a = await prepareSequence(join(dir, "seq.json"));
    const b = await prepareSequence(join(dir, "seq.json"));
    expect(b.parts.map((x) => x.key)).toEqual(a.parts.map((x) => x.key));
    // Same storyboard, different place in the sequence (intro/outro differ).
    expect(a.parts[0]!.key).not.toBe(a.parts[2]!.key);
    await utimes(join(dir, "feature/rec.mp4"), new Date(), new Date(Date.now() + 5000));
    const c = await prepareSequence(join(dir, "seq.json"));
    expect(c.parts[0]!.key).toBe(a.parts[0]!.key);
    expect(c.parts[1]!.key).not.toBe(a.parts[1]!.key);
  });
});

describe("inserting a feature clip into a demo (from/to)", () => {
  async function fixture() {
    const dir = await tempDir();
    makeVideo(join(dir, "demo.mp4"), 5, { audio: true });
    await mkdir(join(dir, "feature"), { recursive: true });
    makeVideo(join(dir, "feature/rec.mp4"), 1.5);
    await writeJson(join(dir, "demo.json"), {
      source: "demo.mp4",
      keepSourceAudio: true,
      output: { width: 320, height: 180, fps: 30 },
      intro: { title: "Demo", dur: 1 },
      outro: { title: "Thanks", dur: 1 },
      captions: [
        { at: 1, dur: 1.8, text: "before" },
        { at: 3, text: "after" },
      ],
    });
    await writeJson(join(dir, "feature/feature.json"), { source: "rec.mp4", captions: [{ at: 0.2, text: "new" }] });
    await writeJson(join(dir, "seq.json"), {
      parts: [{ storyboard: "demo.json", to: 2.5 }, { storyboard: "feature/feature.json" }, { storyboard: "demo.json", from: 2.5 }],
    });
    return dir;
  }

  it("splits the same storyboard around the inserted part", async () => {
    const dir = await fixture();
    const p = await prepareSequence(join(dir, "seq.json"));
    const [a, f, b] = p.parts.map((x) => x.sb);
    expect(a!.segments).toEqual([{ in: 0, out: 2.5, speed: 1 }]);
    expect(b!.segments).toEqual([{ in: 2.5, out: 5, speed: 1 }]);
    expect(a!.captions.map((c) => [c.text, c.at, c.dur])).toEqual([["before", 1, 1.5]]);
    expect(b!.captions.map((c) => [c.text, c.at, c.dur])).toEqual([["after", 3, 3]]);
    expect(f!.segments).toEqual([]);
    expect([a!.intro?.title, f!.intro, b!.intro]).toEqual(["Demo", undefined, undefined]);
    expect([a!.outro, f!.outro, b!.outro?.title]).toEqual([undefined, undefined, "Thanks"]);
    expect(new Set(p.parts.map((x) => x.dir)).size).toBe(3);
    expect(p.parts[0]!.key).not.toBe(p.parts[2]!.key);
  });

  it("cuts each part and joins them in order (prepared builds + real ffmpeg join)", async () => {
    const dir = await fixture();
    const p = await prepareSequence(join(dir, "seq.json"));
    const builds = [];
    for (const part of p.parts) builds.push(await prepareBuild(part.storyboard, { buildDir: join(part.dir, "build"), cacheDir: part.cacheDir }));
    expect(builds.map((b) => b.plan.duration)).toEqual([3.5, 1.5, 3.5]);
    const edited = await Promise.all(builds.map((b) => probePart(join(b.buildDir, "edited.mp4"))));
    expect(edited.map((e) => Math.round(e.duration * 10) / 10)).toEqual([2.5, 1.5, 2.5]);
    expect(edited.map((e) => e.hasAudio)).toEqual([true, false, true]);
    const r = await concatParts(edited, join(dir, "out.mp4"), p.output, { workDir: p.buildDir, quality: "draft" });
    expect(r.mode).toBe("encode");
    const info = await probeVideo(r.output);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeCloseTo(6.5, 1);
  });

  it("validates ranges against the recording", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "seq.json"), {
      parts: [
        { storyboard: "demo.json", to: 9 },
        { storyboard: "demo.json", from: 7 },
      ],
    });
    const err = await validateSequence(join(dir, "seq.json")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect((err as StoryboardError).issues.join("\n")).toMatch(/parts\[1\].*keeps nothing/);
    await writeJson(join(dir, "seq.json"), { parts: [{ storyboard: "demo.json", to: 9 }] });
    expect((await validateSequence(join(dir, "seq.json"))).warnings.join("\n")).toMatch(/parts\[0\].*to 9s is past the end/);
  });

  it("rejects to <= from in the schema", () => {
    expect(SequenceSchema.safeParse({ parts: [{ storyboard: "a.json", from: 3, to: 2 }] }).success).toBe(false);
  });
});

describe("validateSequence", () => {
  it("reports a broken part with its index", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "bad.json"), { source: 3 });
    await writeJson(join(dir, "seq.json"), { parts: [{ storyboard: "bad.json" }] });
    const err = await validateSequence(join(dir, "seq.json")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect((err as StoryboardError).issues.join("\n")).toMatch(/parts\[0\].*source/);
  });

  it("warns about a missing source", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "a.json"), { source: "nope.mp4" });
    await writeJson(join(dir, "seq.json"), { parts: [{ storyboard: "a.json" }] });
    const r = await validateSequence(join(dir, "seq.json"));
    expect(r.valid).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/parts\[0\].*source not found/);
  });
});

describe("buildConcatFilter", () => {
  it("normalizes every part and fills silent parts with silence", () => {
    const f = buildConcatFilter(
      [
        { duration: 2, hasAudio: true },
        { duration: 1.5, hasAudio: false },
      ],
      { width: 1280, height: 720, fps: 30 },
    );
    expect(f.audio).toBe(true);
    expect(f.filter).toContain("[0:v]");
    expect(f.filter).toContain("scale=1280:720");
    expect(f.filter).toContain("anullsrc=r=48000:cl=stereo");
    expect(f.filter).toContain("atrim=duration=1.500");
    expect(f.filter).toMatch(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[vout\]\[aout\]/);
    expect(f.duration).toBeCloseTo(3.5);
  });

  it("stays video-only when no part has audio", () => {
    const f = buildConcatFilter([{ duration: 1, hasAudio: false }], { width: 640, height: 360, fps: 30 });
    expect(f.audio).toBe(false);
    expect(f.filter).not.toContain("anullsrc");
  });
});

describe("transitions between parts", () => {
  const out = { width: 320, height: 180, fps: 30 };

  it("cross-fades video and audio, timed on the real durations", () => {
    const f = buildConcatFilter(
      [
        { duration: 2, hasAudio: true },
        { duration: 3, hasAudio: true, transition: { type: "crossfade", dur: 0.5 } },
      ],
      out,
    );
    expect(f.filter).toContain("[v0][v1]xfade=transition=fade:duration=0.500:offset=1.500[vout]");
    expect(f.filter).toContain("[a0][a1]acrossfade=d=0.500[aout]");
    expect(f.overlaps).toEqual([0, 0.5]);
    expect(f.duration).toBeCloseTo(4.5);
  });

  it("never lets a transition take more than half of either part", () => {
    const f = buildConcatFilter(
      [
        { duration: 0.6, hasAudio: false },
        { duration: 3, hasAudio: false, transition: { type: "fade-black", dur: 1 } },
      ],
      out,
    );
    expect(f.filter).toContain("xfade=transition=fadeblack:duration=0.300:offset=0.300");
    expect(f.duration).toBeCloseTo(3.3);
  });

  it("mixes cuts and transitions, ignoring a transition on the first part", () => {
    const f = buildConcatFilter(
      [
        { duration: 2, hasAudio: false, transition: { type: "crossfade", dur: 0.5 } },
        { duration: 1, hasAudio: false, transition: { type: "cut", dur: 0.5 } },
        { duration: 2, hasAudio: false, transition: { type: "wipe-left", dur: 0.4 } },
      ],
      out,
    );
    expect(f.filter).toContain("[v0][v1]concat=n=2:v=1:a=0[xv1]");
    expect(f.filter).toContain("[xv1][v2]xfade=transition=wipeleft:duration=0.400:offset=2.600[vout]");
    expect(f.overlaps).toEqual([0, 0, 0.4]);
    expect(f.duration).toBeCloseTo(4.6);
  });

  it("maps every transition to an ffmpeg xfade", () => {
    const names = ["wipe-right", "slide-left", "slide-right"] as const;
    const graphs = names.map(
      (type) =>
        buildConcatFilter(
          [
            { duration: 2, hasAudio: false },
            { duration: 2, hasAudio: false, transition: { type, dur: 0.5 } },
          ],
          out,
        ).filter,
    );
    expect(graphs.map((g) => /transition=(\w+)/.exec(g)?.[1])).toEqual(["wiperight", "slideleft", "slideright"]);
  });

  it("joins real clips with overlaps (duration = sum - overlaps)", async () => {
    const dir = await tempDir();
    const media = await Promise.all(
      [
        makeVideo(join(dir, "a.mp4"), 2, { audio: true }),
        makeVideo(join(dir, "b.mp4"), 1.5),
        makeVideo(join(dir, "c.mp4"), 2, { audio: true }),
      ].map(probePart),
    );
    const parts = [
      media[0]!,
      { ...media[1]!, transition: { type: "crossfade" as const, dur: 0.5 } },
      { ...media[2]!, transition: { type: "slide-right" as const, dur: 0.5 } },
    ];
    const r = await concatParts(parts, join(dir, "out.mp4"), out, { workDir: dir, quality: "draft" });
    expect(r.mode).toBe("encode");
    const info = await probeVideo(r.output);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeCloseTo(5.5 - 1, 1);
  });

  it("re-encodes identical parts when a transition joins them", async () => {
    const dir = await tempDir();
    const [a, b] = await Promise.all([makeVideo(join(dir, "a.mp4"), 1), makeVideo(join(dir, "b.mp4"), 1)].map(probePart));
    const r = await concatParts([a!, { ...b!, transition: { type: "crossfade", dur: 0.25 } }], join(dir, "out.mp4"), out, { workDir: dir });
    expect(r.mode).toBe("encode");
    expect((await probeVideo(r.output)).duration).toBeCloseTo(1.75, 1);
  });

  it("is part of the sequence schema with a 0.5 s default", () => {
    const s = SequenceSchema.parse({ parts: [{ storyboard: "a.json" }, { storyboard: "b.json", transition: { type: "wipe-right" } }] });
    expect(s.parts[1]!.transition).toEqual({ type: "wipe-right", dur: 0.5 });
    expect(SequenceSchema.safeParse({ parts: [{ storyboard: "a.json", transition: { type: "spin" } }] }).success).toBe(false);
  });
});

describe("concatParts (real ffmpeg)", () => {
  it("stream-copies identical parts", async () => {
    const dir = await tempDir();
    const parts = await Promise.all([makeVideo(join(dir, "a.mp4"), 1, { audio: true }), makeVideo(join(dir, "b.mp4"), 2, { audio: true })].map(probePart));
    const r = await concatParts(parts, join(dir, "out.mp4"), { width: 320, height: 180, fps: 30 }, { workDir: dir });
    expect(r.mode).toBe("copy");
    const info = await probeVideo(r.output);
    expect(info.duration).toBeCloseTo(3, 1);
    expect(info.hasAudio).toBe(true);
  });

  it("re-encodes when a part has no audio, adding silence for it", async () => {
    const dir = await tempDir();
    const parts = await Promise.all(
      [makeVideo(join(dir, "a.mp4"), 1, { audio: true }), makeVideo(join(dir, "b.mp4"), 1.5, { size: "640x360" })].map(probePart),
    );
    expect(parts.map((p) => p.hasAudio)).toEqual([true, false]);
    const r = await concatParts(parts, join(dir, "out.mp4"), { width: 320, height: 180, fps: 30 }, { workDir: dir, quality: "draft" });
    expect(r.mode).toBe("encode");
    const info = await probeVideo(r.output);
    expect(info).toMatchObject({ width: 320, height: 180, hasAudio: true });
    expect(info.duration).toBeCloseTo(2.5, 1);
  });
});

describe("parts that are sequences or finished videos", () => {
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  const ffmpegIt = hasFfmpeg ? it : it.skip;

  it("accepts {sequence} and {video}, rejects mixing kinds or from/to on a sequence", () => {
    expect(SequenceSchema.safeParse({ parts: [{ sequence: "inner.json" }, { video: "a.mp4", from: 1, to: 2 }] }).success).toBe(true);
    expect(SequenceSchema.safeParse({ parts: [{ sequence: "inner.json", from: 1 }] }).success).toBe(false);
    expect(SequenceSchema.safeParse({ parts: [{ sequence: "inner.json", to: 4 }] }).success).toBe(false);
    expect(SequenceSchema.safeParse({ parts: [{ storyboard: "a.json", video: "a.mp4" }] }).success).toBe(false);
    expect(SequenceSchema.safeParse({ parts: [{ transition: { type: "crossfade" } }] }).success).toBe(false);
    expect(SequenceSchema.safeParse({ parts: [{ video: "a.mp4", from: 3, to: 2 }] }).success).toBe(false);
  });

  it("describes the three kinds in the JSON schema", () => {
    const parts = (sequenceJsonSchema() as { properties: { parts: { items: { properties: Record<string, unknown> } } } }).properties.parts;
    expect(Object.keys(parts.items.properties)).toEqual(expect.arrayContaining(["storyboard", "sequence", "video"]));
  });

  it("fails validation on a cycle a -> b -> a and prints the chain", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "a.json"), { parts: [{ sequence: "b.json" }] });
    await writeJson(join(dir, "b.json"), { parts: [{ sequence: "a.json" }] });
    const err = await validateSequence(join(dir, "a.json")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect((err as StoryboardError).issues.join("\n")).toContain("a.json → b.json → a.json");
    const self = join(dir, "self.json");
    await writeJson(self, { parts: [{ sequence: "self.json" }] });
    const err2 = await validateSequence(self).catch((e: unknown) => e);
    expect((err2 as StoryboardError).issues.join("\n")).toContain("self.json → self.json");
    await expect(prepareSequence(join(dir, "a.json"))).rejects.toThrow(StoryboardError);
  });

  it("reports a missing nested sequence and a missing video", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "seq.json"), { parts: [{ sequence: "nope.json" }] });
    const err = await validateSequence(join(dir, "seq.json")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect((err as StoryboardError).issues.join("\n")).toMatch(/parts\[0\].*nope\.json/);
    await writeJson(join(dir, "v.json"), { parts: [{ video: "nope.mp4" }] });
    const r = await validateSequence(join(dir, "v.json"));
    expect(r.warnings.join("\n")).toMatch(/parts\[0\].*video not found/);
  });

  ffmpegIt("joins two finished videos with fade-black: duration = d1 + d2 - dur", async () => {
    const dir = await tempDir();
    makeVideo(join(dir, "a.mp4"), 2, { audio: true });
    makeVideo(join(dir, "b.mp4"), 1.5, { audio: true });
    await writeJson(join(dir, "seq.json"), {
      parts: [{ video: "a.mp4" }, { video: "b.mp4", transition: { type: "fade-black", dur: 0.5 } }],
    });
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(r.join).toBe("encode");
    expect(r.duration).toBeGreaterThan(3.0 - 0.05);
    expect(r.duration).toBeLessThan(3.0 + 0.05);
  });

  ffmpegIt("trims a video part with from/to in its own seconds", async () => {
    const dir = await tempDir();
    makeVideo(join(dir, "a.mp4"), 4);
    makeVideo(join(dir, "b.mp4"), 1);
    await writeJson(join(dir, "seq.json"), { parts: [{ video: "a.mp4", from: 1, to: 3 }, { video: "b.mp4" }] });
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(r.duration).toBeGreaterThan(3 - 0.1);
    expect(r.duration).toBeLessThan(3 + 0.1);
  });

  ffmpegIt("renders a nested sequence once, reuses it until one of its parts changes, and joins it with transitions", async () => {
    const dir = await tempDir();
    makeVideo(join(dir, "a.mp4"), 2);
    makeVideo(join(dir, "b.mp4"), 2);
    makeVideo(join(dir, "c.mp4"), 2);
    await writeJson(join(dir, "inner.json"), { parts: [{ video: "a.mp4" }, { video: "b.mp4", transition: { type: "crossfade", dur: 0.5 } }] });
    await writeJson(join(dir, "outer.json"), {
      parts: [{ sequence: "inner.json" }, { video: "c.mp4", transition: { type: "fade-black", dur: 0.5 } }],
    });
    const first = await renderSequence(join(dir, "outer.json"), { quality: "draft" });
    // inner = 2 + 2 - 0.5 = 3.5; outer = 3.5 + 2 - 0.5 = 5
    expect(first.duration).toBeGreaterThan(5 - 0.05);
    expect(first.duration).toBeLessThan(5 + 0.05);
    expect(first.parts.map((p) => [p.kind, p.cached])).toEqual([["sequence", false], ["video", true]]);

    const second = await renderSequence(join(dir, "outer.json"), { quality: "draft" });
    expect(second.parts.map((p) => p.cached)).toEqual([true, true]);
    expect(second.duration).toBeCloseTo(first.duration, 1);

    // Change a file inside the nested sequence: the nested part is rebuilt.
    makeVideo(join(dir, "b.mp4"), 2.5);
    const third = await renderSequence(join(dir, "outer.json"), { quality: "draft" });
    expect(third.parts.map((p) => p.cached)).toEqual([false, true]);
    expect(third.duration).toBeGreaterThan(5.5 - 0.05);
    expect(third.duration).toBeLessThan(5.5 + 0.05);
  }, 60_000);
});

describe("sequence --style", () => {
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  const ffmpegIt = hasFfmpeg ? it : it.skip;

  async function fixture() {
    const dir = await tempDir();
    makeVideo(join(dir, "rec.mp4"), 2);
    makeVideo(join(dir, "clip.mp4"), 1);
    await writeJson(join(dir, "demo.json"), {
      source: "rec.mp4",
      output: { width: 320, height: 180, fps: 10 },
      theme: { accent: "#111111", background: "#000000" },
    });
    await writeJson(join(dir, "red.json"), { theme: { accent: "#ff0000" } });
    await writeJson(join(dir, "blue.json"), { theme: { accent: "#0000ff" } });
    await writeJson(join(dir, "seq.json"), { parts: [{ storyboard: "demo.json" }, { video: "clip.mp4" }] });
    await writeJson(join(dir, "inner.json"), { parts: [{ storyboard: "demo.json" }] });
    await writeJson(join(dir, "outer.json"), { parts: [{ sequence: "inner.json" }, { storyboard: "demo.json" }] });
    return dir;
  }
  const styleOf = (dir: string, name: string) => loadStyle(join(dir, `${name}.json`));
  const derivedTheme = async (storyboard: string) => JSON.parse(await readFile(storyboard, "utf8")).theme;

  it("writes the merged theme into the derived storyboard of every part and leaves the user's files alone", async () => {
    const dir = await fixture();
    const before = await readFile(join(dir, "demo.json"), "utf8");
    const p = await prepareSequence(join(dir, "seq.json"), { style: await styleOf(dir, "red") });
    expect(await derivedTheme((p.parts[0] as { storyboard: string }).storyboard)).toMatchObject({ accent: "#ff0000", background: "#000000" });
    expect(await readFile(join(dir, "demo.json"), "utf8")).toBe(before);
  });

  it("names the build folder after the style and keeps the plain one without a style", async () => {
    const dir = await fixture();
    expect((await prepareSequence(join(dir, "seq.json"))).buildDir).toBe(join(dir, "seq.build"));
    const red = await prepareSequence(join(dir, "seq.json"), { style: await styleOf(dir, "red") });
    expect(red.buildDir).toBe(join(dir, "seq.red.build"));
    expect(red.parts[0]!.dir).toBe(join(dir, "seq.red.build", "part-0"));
  });

  it("changes the part key and the sequence key with the style, and keeps them for the same style", async () => {
    const dir = await fixture();
    const plain = await prepareSequence(join(dir, "seq.json"));
    const red = await prepareSequence(join(dir, "seq.json"), { style: await styleOf(dir, "red") });
    const red2 = await prepareSequence(join(dir, "seq.json"), { style: await styleOf(dir, "red") });
    const blue = await prepareSequence(join(dir, "seq.json"), { style: await styleOf(dir, "blue") });
    expect(red.parts[0]!.key).not.toBe(plain.parts[0]!.key);
    expect(red.parts[0]!.key).not.toBe(blue.parts[0]!.key);
    expect(red2.parts[0]!.key).toBe(red.parts[0]!.key);
    expect(red.key).not.toBe(blue.key);
    expect(red2.key).toBe(red.key);
  });

  it("gives a nested sequence the same style, its own build folder and its own key", async () => {
    const dir = await fixture();
    const plain = await prepareSequence(join(dir, "outer.json"));
    const red = await prepareSequence(join(dir, "outer.json"), { style: await styleOf(dir, "red") });
    const nested = red.parts[0]!;
    if (nested.kind !== "sequence") throw new Error("expected a nested sequence");
    expect(nested.sequence.buildDir).toBe(join(dir, "inner.red.build"));
    expect(await derivedTheme((nested.sequence.parts[0] as { storyboard: string }).storyboard)).toMatchObject({ accent: "#ff0000" });
    expect(nested.key).not.toBe(plain.parts[0]!.key);
    const blue = await prepareSequence(join(dir, "outer.json"), { style: await styleOf(dir, "blue") });
    expect(blue.parts[0]!.key).not.toBe(nested.key);
  });

  it("warns that a finished video part is not styled", async () => {
    const dir = await fixture();
    const red = await prepareSequence(join(dir, "seq.json"), { style: await styleOf(dir, "red") });
    const video = red.parts[1]!;
    if (video.kind !== "video") throw new Error("expected a video part");
    expect(video.warnings.join("\n")).toMatch(/style "red" is not applied to clip\.mp4/);
    const plain = await prepareSequence(join(dir, "seq.json"));
    expect((plain.parts[1] as { warnings: string[] }).warnings).toEqual([]);
  });

  ffmpegIt("renders each style into its own folder and output, and reuses an unchanged style", async () => {
    const dir = await fixture();
    const red = await styleOf(dir, "red");
    const blue = await styleOf(dir, "blue");
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const a = await renderSequence(join(dir, "seq.json"), { quality: "draft", style: red, log });
    expect(a.output).toBe(join(dir, "seq.red.mp4"));
    expect(a.parts[0]!.cached).toBe(false);
    expect(a.parts[1]!.warnings.join("\n")).toMatch(/not applied/);

    const b = await renderSequence(join(dir, "seq.json"), { quality: "draft", style: blue, log });
    expect(b.output).toBe(join(dir, "seq.blue.mp4"));
    expect(b.parts[0]!.cached).toBe(false);
    expect(a.parts[0]!.output).not.toBe(b.parts[0]!.output);
    expect(existsSync(a.parts[0]!.output)).toBe(true);
    expect(existsSync(b.parts[0]!.output)).toBe(true);

    logs.length = 0;
    const again = await renderSequence(join(dir, "seq.json"), { quality: "draft", style: red, log });
    expect(again.parts[0]!.cached).toBe(true);
    expect(logs.join("\n")).toMatch(/unchanged, reusing/);
  }, 60_000);

  ffmpegIt("without a style the output stays <sequence>.mp4", async () => {
    const dir = await fixture();
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(r.output).toBe(join(dir, "seq.mp4"));
  }, 60_000);
});
