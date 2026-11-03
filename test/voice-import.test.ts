import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportScript, importAudio } from "../src/voice/import.js";

async function project(narration: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "sp-import-"));
  const storyboard = join(dir, "storyboard.json");
  await writeFile(storyboard, JSON.stringify({ source: "a.mp4", segments: [{ in: 0, out: 20, speed: 1 }], narration }));
  return { dir, storyboard };
}

function twoLines(file: string): void {
  const inputs = ["sine=frequency=300:sample_rate=24000:duration=1.2", "anullsrc=r=24000:cl=mono:d=1.2", "sine=frequency=500:sample_rate=24000:duration=1.5"];
  const args = ["-y", "-loglevel", "error"];
  for (const i of inputs) args.push("-f", "lavfi", "-i", i);
  args.push("-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[o]", "-map", "[o]", file);
  execFileSync("ffmpeg", args);
}

describe("exportScript", () => {
  it("writes <storyboard>.script.md next to the storyboard", async () => {
    const { dir, storyboard } = await project([{ at: 2, text: "Open the panel." }, { at: 8, text: "Press save." }]);
    const r = await exportScript(storyboard);
    expect(r.file).toBe(join(dir, "storyboard.script.md"));
    expect(r.lines).toBe(2);
    expect(r.text).toBe("Open the panel.\n\nPress save.");
    expect(await readFile(r.file, "utf8")).toContain("Open the panel.");
  });

  it("honours --out", async () => {
    const { dir, storyboard } = await project([{ at: 2, text: "Hi." }]);
    const r = await exportScript(storyboard, join(dir, "my-script.md"));
    expect(existsSync(join(dir, "my-script.md"))).toBe(true);
    expect(r.file).toBe(join(dir, "my-script.md"));
  });
});

describe("importAudio", () => {
  it("splits one recording by the storyboard's line count and attaches the files", async () => {
    const { dir, storyboard } = await project([{ at: 2, text: "one" }, { at: 8, text: "two" }]);
    const audio = join(dir, "voice.wav");
    twoLines(audio);
    const r = await importAudio(audio, { storyboard });
    expect(r.files).toHaveLength(2);
    expect(r.files.every(existsSync)).toBe(true);
    expect(r.attached).toBe(true);
    const sb = JSON.parse(await readFile(storyboard, "utf8"));
    expect(sb.narration[0].audio).toBe("narration-audio/01.wav");
    expect(sb.narration[1].audio).toBe("narration-audio/02.wav");
  });

  it("splits by --lines without touching any storyboard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-import-"));
    const audio = join(dir, "voice.wav");
    twoLines(audio);
    const r = await importAudio(audio, { lines: 2 });
    expect(r.attached).toBe(false);
    expect(r.files[0]).toBe(join(dir, "voice-lines", "01.wav"));
  });

  it("needs a storyboard or a line count", async () => {
    await expect(importAudio("x.wav", {})).rejects.toThrow(/--storyboard or --lines/);
  });
});
