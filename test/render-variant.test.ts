import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderFormats, renderStoryboard } from "../src/render/index.js";
import { parseFormats } from "../src/render/formats.js";
import { loadStyle } from "../src/storyboard/load.js";
import { loadVariant } from "../src/storyboard/variant.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames (a headless Chrome render) is faked: it just writes the file passed with -o. ffmpeg and ffprobe are real.
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

const ffmpegDescribe = spawnSync("ffmpeg", ["-version"]).status === 0 ? describe : describe.skip;

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-render-variant-"));
  makeVideo(join(dir, "rec.mp4"), 6);
  await writeJson(join(dir, "demo.json"), {
    source: "rec.mp4",
    output: { width: 320, height: 180, fps: 10 },
    narration: [
      { at: 0, text: "hello there", id: "a" },
      { at: 3, text: "second line" },
    ],
  });
  await writeJson(join(dir, "variants", "saudi.json"), { narration: { a: "marhaba", "1": "alsatr althani" }, voice: { name: "ar-SA-HamedNeural" } });
  await writeJson(join(dir, "variants", "egypt.json"), { narration: { a: "ezayak", "1": "el satr el tany" } });
  await writeJson(join(dir, "red.json"), { theme: { accent: "#ff0000" } });
  return dir;
}

beforeAll(() => {
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = join(tmpdir(), "sp-render-variant-extract");
});
beforeEach(() => {
  spoken.length = 0;
});

ffmpegDescribe("render --variant", () => {
  it("without a variant keeps today's paths", async () => {
    const dir = await fixture();
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    expect(r.output).toBe(join(dir, "demo.mp4"));
    expect(r.buildDir).toBe(join(dir, "demo.build"));
  });

  it("renders with the variant's text and voice into <name>.<variant>.mp4 and its own build folder", async () => {
    const dir = await fixture();
    const sb = join(dir, "demo.json");
    const r = await renderStoryboard(sb, { quality: "draft", variant: await loadVariant("saudi", sb) });
    expect(r.output).toBe(join(dir, "demo.saudi.mp4"));
    expect(r.buildDir).toBe(join(dir, "demo.saudi.build"));
    expect(existsSync(r.output)).toBe(true);
    expect(spoken).toEqual([
      { text: "marhaba", voice: "ar-SA-HamedNeural", rate: "+0%" },
      { text: "alsatr althani", voice: "ar-SA-HamedNeural", rate: "+0%" },
    ]);
    expect(await readFile(join(r.buildDir, "index.html"), "utf8")).toContain("marhaba");
  });

  it("render A, B, A: the third render is a full cache hit (no synthesis, the cut is reused, B's folder untouched)", async () => {
    const dir = await fixture();
    const sb = join(dir, "demo.json");
    const saudi = await loadVariant("saudi", sb);
    const egypt = await loadVariant("egypt", sb);
    await renderStoryboard(sb, { quality: "draft", variant: saudi });
    const b = await renderStoryboard(sb, { quality: "draft", variant: egypt });
    expect(b.output).toBe(join(dir, "demo.egypt.mp4"));
    const spokenBefore = spoken.length;
    const lines: string[] = [];
    const a = await renderStoryboard(sb, { quality: "draft", variant: saudi, log: (m) => lines.push(m) });
    expect(spoken.length).toBe(spokenBefore);
    expect(lines).toContain("cut: unchanged, reusing edited.mp4");
    expect(a.output).toBe(join(dir, "demo.saudi.mp4"));
    // One voice cache next to the storyboard: 4 clips (2 lines x 2 variants; the voice differs for saudi).
    expect((await readdir(join(dir, ".screenpilot-cache", "voice"))).filter((f) => f.endsWith(".mp3"))).toHaveLength(4);
  });

  it("composes with --style: <name>.<variant>.<style>", async () => {
    const dir = await fixture();
    const sb = join(dir, "demo.json");
    const r = await renderStoryboard(sb, { quality: "draft", variant: await loadVariant("saudi", sb), style: await loadStyle(join(dir, "red.json")) });
    expect(r.output).toBe(join(dir, "demo.saudi.red.mp4"));
    expect(r.buildDir).toBe(join(dir, "demo.saudi.red.build"));
    const w = await renderStoryboard(sb, { quality: "draft", variant: await loadVariant("saudi", sb), window: { from: 0.5, to: 1.5 } });
    expect(w.output).toBe(join(dir, "demo.saudi.part-0.5-1.5.mp4"));
  });

  it("puts the variant before the style and format in --formats names", async () => {
    const dir = await fixture();
    const sb = join(dir, "demo.json");
    const rs = await renderFormats(sb, parseFormats("16:9"), { quality: "draft", variant: await loadVariant("saudi", sb), style: await loadStyle(join(dir, "red.json")) });
    expect(rs[0]!.output).toBe(join(dir, "demo.saudi.red.16x9.mp4"));
    expect(rs[0]!.buildDir).toBe(join(dir, "demo.saudi.red.16x9.build"));
  });
});
