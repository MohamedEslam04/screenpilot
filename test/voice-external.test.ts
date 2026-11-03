import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareBuild } from "../src/render/index.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { externalClip } from "../src/voice/external.js";
import { makeVideo } from "./fixtures/video.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-ext-"));
});

function tone(file: string, seconds: number): string {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-ar", "24000", file]);
  return file;
}

describe("narration audio field", () => {
  it("is accepted by the schema and optional", () => {
    const sb = StoryboardSchema.parse({ source: "a.mp4", narration: [{ at: 1, text: "hi", audio: "voice/01.mp3" }, { at: 2, text: "yo" }] });
    expect(sb.narration[0]!.audio).toBe("voice/01.mp3");
    expect(sb.narration[1]!.audio).toBeUndefined();
  });
});

describe("externalClip", () => {
  it("measures the file and never writes a sidecar next to the user's audio", async () => {
    const file = tone(join(dir, "01.wav"), 1.5);
    const clip = await externalClip({ text: "hello", voice: "v", rate: "+0%" }, file, 0);
    expect(clip.file).toBe(file);
    expect(clip.text).toBe("hello");
    expect(clip.duration).toBeGreaterThan(1.4);
    expect(clip.duration).toBeLessThan(1.6);
    expect(existsSync(`${file}.dur`)).toBe(false);
  });

  it("names the line and the path when the file is missing", async () => {
    await expect(externalClip({ text: "x", voice: "v", rate: "+0%" }, join(dir, "nope.mp3"), 3)).rejects.toThrow(/narration\[3\].*audio.*nope\.mp3/s);
  });
});

describe("prepareBuild with ready-made audio", () => {
  it("uses the files instead of a voice and keeps same-named files apart", async () => {
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    tone(join(dir, "a", "01.wav"), 1);
    tone(join(dir, "b", "01.wav"), 2);
    makeVideo(join(dir, "src.mp4"), 6);
    const sbPath = join(dir, "storyboard.json");
    await writeFile(
      sbPath,
      JSON.stringify({
        source: "src.mp4",
        segments: [{ in: 0, out: 6, speed: 1 }],
        narration: [
          { at: 0.5, text: "first", audio: "a/01.wav" },
          { at: 3, text: "second", audio: "b/01.wav" },
        ],
      }),
    );
    const p = await prepareBuild(sbPath, { buildDir: join(dir, "build"), cacheDir: join(dir, "cache") });
    expect(existsSync(join(p.buildDir, "voice", "ext-0.wav"))).toBe(true);
    expect(existsSync(join(p.buildDir, "voice", "ext-1.wav"))).toBe(true);
    const html = await readFile(join(p.buildDir, "index.html"), "utf8");
    expect(html).toContain("voice/ext-0.wav");
    expect(html).toContain("voice/ext-1.wav");
  });

  it("fails clearly when a file is missing", async () => {
    makeVideo(join(dir, "src.mp4"), 4);
    const sbPath = join(dir, "storyboard.json");
    await writeFile(sbPath, JSON.stringify({ source: "src.mp4", narration: [{ at: 0.5, text: "x", audio: "gone.mp3" }] }));
    await expect(prepareBuild(sbPath, { buildDir: join(dir, "build"), cacheDir: join(dir, "cache") })).rejects.toThrow(/narration\[0\].*gone\.mp3/s);
  });
});
