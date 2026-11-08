import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderFormats, renderStoryboard } from "../src/render/index.js";
import { parseFormats } from "../src/render/formats.js";
import { loadStyle } from "../src/storyboard/load.js";
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

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpegDescribe = hasFfmpeg ? describe : describe.skip;

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-render-style-"));
  makeVideo(join(dir, "rec.mp4"), 2);
  await writeJson(join(dir, "demo.json"), { source: "rec.mp4", output: { width: 320, height: 180, fps: 10 } });
  await writeJson(join(dir, "red.json"), { theme: { accent: "#ff0000" } });
  await writeJson(join(dir, "Blue Look.json"), { theme: { accent: "#0000ff" } });
  return dir;
}

beforeAll(() => {
  // Keep the render's frame cache out of the user's real cache folder.
  process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = join(tmpdir(), "sp-render-style-extract");
});

ffmpegDescribe("render --style", () => {
  it("without a style keeps today's paths", async () => {
    const dir = await fixture();
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    expect(r.output).toBe(join(dir, "demo.mp4"));
    expect(r.buildDir).toBe(join(dir, "demo.build"));
    expect(existsSync(join(dir, "demo.mp4"))).toBe(true);
  });

  it("gives each style its own build folder and output, and shares the voice cache", async () => {
    const dir = await fixture();
    const red = await loadStyle(join(dir, "red.json"));
    const blue = await loadStyle(join(dir, "Blue Look.json"));
    const a = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", style: red });
    const b = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", style: blue });

    expect(a.output).toBe(join(dir, "demo.red.mp4"));
    expect(b.output).toBe(join(dir, "demo.blue-look.mp4"));
    expect(a.buildDir).toBe(join(dir, "demo.red.build"));
    expect(b.buildDir).toBe(join(dir, "demo.blue-look.build"));
    for (const p of [a.output, b.output, a.buildDir, b.buildDir]) expect(existsSync(p)).toBe(true);

    expect(await readFile(join(a.buildDir, "index.html"), "utf8")).toContain("#ff0000");
    expect(await readFile(join(b.buildDir, "index.html"), "utf8")).toContain("#0000ff");
    expect(await readFile(join(b.buildDir, "index.html"), "utf8")).not.toContain("#ff0000");

    // One voice cache next to the storyboard, none inside a style's build folder.
    expect((await readdir(dir)).filter((f) => f.startsWith(".")).length).toBe(1);
    expect(existsSync(join(dir, ".screenpilot-cache", "voice"))).toBe(true);
    expect(existsSync(join(a.buildDir, "voice"))).toBe(true);
    expect(await readdir(join(a.buildDir, "voice"))).toEqual([]);
  });

  it("an accent-only style leaves the cut key unchanged (the cut depends on source and filter only)", async () => {
    const dir = await fixture();
    const plain = await renderStoryboard(join(dir, "demo.json"), { quality: "draft" });
    const styled = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", style: await loadStyle(join(dir, "red.json")) });
    expect(await readFile(join(styled.buildDir, "edited.key"), "utf8")).toBe(await readFile(join(plain.buildDir, "edited.key"), "utf8"));
  });

  it("puts the style before the window suffix", async () => {
    const dir = await fixture();
    const r = await renderStoryboard(join(dir, "demo.json"), {
      quality: "draft",
      style: await loadStyle(join(dir, "red.json")),
      window: { from: 0.5, to: 1.5 },
    });
    expect(r.output).toBe(join(dir, "demo.red.part-0.5-1.5.mp4"));
    expect(r.buildDir).toBe(join(dir, "demo.red.part-0.5-1.5.build"));
  });

  it("an explicit output wins over the style name", async () => {
    const dir = await fixture();
    const r = await renderStoryboard(join(dir, "demo.json"), { quality: "draft", style: await loadStyle(join(dir, "red.json")), output: join(dir, "out.mp4") });
    expect(r.output).toBe(join(dir, "out.mp4"));
  });

  it("puts the style before the format in --formats names", async () => {
    const dir = await fixture();
    const rs = await renderFormats(join(dir, "demo.json"), parseFormats("16:9"), { quality: "draft", style: await loadStyle(join(dir, "red.json")) });
    expect(rs[0]!.output).toBe(join(dir, "demo.red.16x9.mp4"));
    expect(rs[0]!.buildDir).toBe(join(dir, "demo.red.16x9.build"));
  });
});
