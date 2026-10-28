import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConcatFilter, concatParts, probePart } from "../src/sequence/concat.js";
import { prepareSequence, validateSequence } from "../src/sequence/index.js";
import { sequenceJsonSchema, SequenceSchema } from "../src/sequence/schema.js";
import { StoryboardError } from "../src/storyboard/load.js";
import { probeVideo } from "../src/util/media.js";
import { makeVideo } from "./fixtures/video.js";

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
    expect(p.parts[1]!.cacheDir).toBe(join(dir, "feature", ".screenpilot-cache"));
    // The user's files are untouched.
    expect(await readFile(join(dir, "demo.json"), "utf8")).toBe(before);
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
