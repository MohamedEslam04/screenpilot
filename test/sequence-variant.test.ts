import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSequence, renderSequence, validateSequence } from "../src/sequence/index.js";
import { loadStyle, StoryboardError } from "../src/storyboard/load.js";
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
vi.mock("../src/voice/edge.js", async () => ({ edgeProvider: (await import("./fixtures/fake-edge.js")).fakeEdge }));
const { spoken } = await import("./fixtures/fake-edge.js");

const ffmpegIt = spawnSync("ffmpeg", ["-version"]).status === 0 ? it : it.skip;

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

const board = (lines: string[]) => ({
  source: "rec.mp4",
  output: { width: 320, height: 180, fps: 10 },
  narration: lines.map((text, i) => ({ at: i * 2, text })),
});

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-seq-variant-"));
  for (const ch of ["ch1", "ch2"]) {
    await mkdir(join(dir, ch), { recursive: true });
    makeVideo(join(dir, ch, "rec.mp4"), 4);
    await writeJson(join(dir, ch, "demo.json"), board([`${ch} first line`, `${ch} second line`]));
  }
  makeVideo(join(dir, "clip.mp4"), 1);
  await writeJson(join(dir, "ch1", "variants", "saudi.json"), { narration: ["s1 first", "s1 second"] });
  await writeJson(join(dir, "ch1", "variants", "egypt.json"), { narration: ["e1 first", "e1 second"] });
  await writeJson(join(dir, "alt", "saudi.json"), { narration: ["s2 first", "s2 second"] });
  await writeJson(join(dir, "red.json"), { theme: { accent: "#ff0000" } });
  await writeJson(join(dir, "seq.json"), { parts: [{ storyboard: "ch1/demo.json" }, { storyboard: "ch2/demo.json" }, { video: "clip.mp4" }] });
  await writeJson(join(dir, "inner.json"), { parts: [{ storyboard: "ch1/demo.json" }, { storyboard: "ch2/demo.json" }] });
  await writeJson(join(dir, "outer.json"), { parts: [{ sequence: "inner.json" }, { storyboard: "ch2/demo.json" }] });
  return dir;
}
const derived = async (p: { storyboard?: string }) => JSON.parse(await readFile(p.storyboard!, "utf8"));

beforeEach(() => {
  spoken.length = 0;
});

describe("sequence --variant (prepare)", () => {
  it("applies each part's own variants/<name>.json and writes it into the derived storyboard", async () => {
    const dir = await fixture();
    const p = await prepareSequence(join(dir, "seq.json"), { variant: "saudi", variantDir: join(dir, "alt") });
    expect((await derived(p.parts[0] as never)).narration.map((n: { text: string }) => n.text)).toEqual(["s1 first", "s1 second"]);
    // ch2 has no variants folder: the --variant-dir file is the fallback.
    expect((await derived(p.parts[1] as never)).narration.map((n: { text: string }) => n.text)).toEqual(["s2 first", "s2 second"]);
    expect(p.variant).toBe("saudi");
  });

  it("the part folder wins over --variant-dir", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "alt", "egypt.json"), { narration: ["x", "y"] });
    const p = await prepareSequence(join(dir, "seq.json"), { variant: "egypt", variantDir: join(dir, "alt") });
    expect((await derived(p.parts[0] as never)).narration[0].text).toBe("e1 first");
    expect((await derived(p.parts[1] as never)).narration[0].text).toBe("x");
  });

  it("a part without a variant file renders as written, with a warning, and does not depend on the variant", async () => {
    const dir = await fixture();
    const plain = await prepareSequence(join(dir, "seq.json"));
    const saudi = await prepareSequence(join(dir, "seq.json"), { variant: "saudi" });
    const egypt = await prepareSequence(join(dir, "seq.json"), { variant: "egypt" });
    const [, a, ] = saudi.parts;
    if (a!.kind !== "storyboard") throw new Error("expected a storyboard part");
    expect(a.warnings.join("\n")).toMatch(/no variant "saudi"/);
    // Same folder and key as without a variant, so it is shared between variants (the picture does not depend on it).
    expect(a.dir).toBe(plain.parts[1]!.dir);
    expect(a.key).toBe(plain.parts[1]!.key);
    expect(egypt.parts[1]!.key).toBe(a.key);
    expect(egypt.parts[1]!.dir).toBe(a.dir);
  });

  it("a part that has the variant gets its own folder and key per variant (name and file hash)", async () => {
    const dir = await fixture();
    const plain = await prepareSequence(join(dir, "seq.json"));
    const saudi = await prepareSequence(join(dir, "seq.json"), { variant: "saudi" });
    const saudi2 = await prepareSequence(join(dir, "seq.json"), { variant: "saudi" });
    const egypt = await prepareSequence(join(dir, "seq.json"), { variant: "egypt" });
    expect(saudi.parts[0]!.dir).toBe(join(dir, "seq.build", "part-0.saudi"));
    expect(egypt.parts[0]!.dir).toBe(join(dir, "seq.build", "part-0.egypt"));
    expect(saudi.parts[0]!.key).toBe(saudi2.parts[0]!.key);
    expect(saudi.parts[0]!.key).not.toBe(egypt.parts[0]!.key);
    expect(saudi.parts[0]!.key).not.toBe(plain.parts[0]!.key);
    expect(saudi.key).not.toBe(egypt.key);
    expect(saudi2.key).toBe(saudi.key);
    // An edited variant file changes the key even if the derived text were equal.
    await writeJson(join(dir, "ch1", "variants", "saudi.json"), { narration: ["s1 first", "s1 CHANGED"] });
    expect((await prepareSequence(join(dir, "seq.json"), { variant: "saudi" })).parts[0]!.key).not.toBe(saudi.parts[0]!.key);
  });

  it("warns that a finished video part has no variant", async () => {
    const dir = await fixture();
    const p = await prepareSequence(join(dir, "seq.json"), { variant: "saudi" });
    const video = p.parts[2]!;
    if (video.kind !== "video") throw new Error("expected a video part");
    expect(video.warnings.join("\n")).toMatch(/variant "saudi" is not applied to clip\.mp4/);
  });

  it("fails when no part has the variant (a typo)", async () => {
    const dir = await fixture();
    const err = await prepareSequence(join(dir, "seq.json"), { variant: "saudy" }).catch((e) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect(err.message).toMatch(/saudy/);
    expect(err.message).toMatch(/variants[\\/]saudy\.json/);
  });

  it("a variant that changes the number of lines fails naming the part and both counts", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "ch1", "variants", "bad.json"), { narration: ["only one"] });
    const err = await prepareSequence(join(dir, "seq.json"), { variant: "bad" }).catch((e) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect(err.message).toMatch(/parts\[0\] \(ch1\/demo\.json\)/);
    expect(err.message).toMatch(/1 line\(s\)/);
    expect(err.message).toMatch(/2 line\(s\)/);
  });

  it("passes the variant to a nested sequence; the nested folder is per variant only when something in it depends on it", async () => {
    const dir = await fixture();
    const saudi = await prepareSequence(join(dir, "outer.json"), { variant: "saudi" });
    const nested = saudi.parts[0]!;
    if (nested.kind !== "sequence") throw new Error("expected a nested sequence");
    expect((await derived(nested.sequence.parts[0] as never)).narration[0].text).toBe("s1 first");
    expect(nested.dir).toBe(join(dir, "outer.build", "part-0.saudi"));
    expect(nested.sequence.buildDir).toBe(join(dir, "inner.build"));
    expect(nested.key).not.toBe((await prepareSequence(join(dir, "outer.json"), { variant: "egypt" })).parts[0]!.key);
  });

  it("composes with --style in names: <seq>.<style>.build, parts per variant", async () => {
    const dir = await fixture();
    const p = await prepareSequence(join(dir, "seq.json"), { variant: "saudi", style: await loadStyle(join(dir, "red.json")) });
    expect(p.buildDir).toBe(join(dir, "seq.red.build"));
    expect(p.parts[0]!.dir).toBe(join(dir, "seq.red.build", "part-0.saudi"));
  });
});

describe("sequence --variant (validate)", () => {
  it("validates with the variant applied and warns for a part that lacks it", async () => {
    const dir = await fixture();
    const r = await validateSequence(join(dir, "seq.json"), { variant: "saudi" });
    expect(r.valid).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/parts\[1\] \(ch2\/demo\.json\).*no variant "saudi"/);
  });
});

describe("sequence --variant (render)", () => {
  ffmpegIt("renders A, B, A: parts that do not depend on the variant are reused, the third run is a full cache hit", async () => {
    const dir = await fixture();
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const a = await renderSequence(join(dir, "seq.json"), { quality: "draft", variant: "saudi", log });
    expect(a.output).toBe(join(dir, "seq.saudi.mp4"));
    expect(a.parts.map((p) => p.cached)).toEqual([false, false, true]);
    expect(a.parts[1]!.warnings.join("\n")).toMatch(/no variant "saudi"/);

    const b = await renderSequence(join(dir, "seq.json"), { quality: "draft", variant: "egypt", log });
    expect(b.output).toBe(join(dir, "seq.egypt.mp4"));
    // ch1 depends on the variant (rendered again); ch2 does not (same folder and key as the first run: cache hit).
    expect(b.parts.map((p) => p.cached)).toEqual([false, true, true]);
    expect(existsSync(a.output)).toBe(true);
    expect(existsSync(b.output)).toBe(true);

    const spokenBefore = spoken.length;
    logs.length = 0;
    const again = await renderSequence(join(dir, "seq.json"), { quality: "draft", variant: "saudi", log });
    expect(again.parts.map((p) => p.cached)).toEqual([true, true, true]);
    expect(spoken.length).toBe(spokenBefore);
    expect(logs.join("\n")).toMatch(/part 1\/3: unchanged, reusing/);
  }, 90_000);

  ffmpegIt("without a variant the output stays <sequence>.mp4 and nothing is named after a variant", async () => {
    const dir = await fixture();
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    expect(r.output).toBe(join(dir, "seq.mp4"));
  }, 60_000);

  ffmpegIt("names the output <sequence>.<variant>.<style>.mp4", async () => {
    const dir = await fixture();
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft", variant: "saudi", style: await loadStyle(join(dir, "red.json")) });
    expect(r.output).toBe(join(dir, "seq.saudi.red.mp4"));
  }, 60_000);
});
