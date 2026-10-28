import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStoryboard, StoryboardError } from "../src/storyboard/load.js";
import { storyboardJsonSchema } from "../src/storyboard/schema.js";

async function files(tree: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-extends-"));
  for (const [name, data] of Object.entries(tree)) {
    const p = join(dir, name);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, JSON.stringify(data));
  }
  return dir;
}

describe("storyboard extends", () => {
  it("inherits theme, voice, output, music and keepSourceAudio, the child winning key by key", async () => {
    const dir = await files({
      "base.json": {
        source: "base.mp4",
        keepSourceAudio: true,
        output: { width: 1080, height: 1920, fps: 60 },
        theme: { accent: "#ff0000", padding: 0.1, motion: { captions: { in: "pop", duration: 0.5 } } },
        voice: { name: "ar-EG-SalmaNeural", rate: "+10%" },
        captions: [{ at: 1, text: "from base" }],
        zooms: [{ at: 1, dur: 2, x: 0.5, y: 0.5 }],
        intro: { title: "Base intro" },
      },
      "child.json": {
        extends: "base.json",
        source: "child.mp4",
        theme: { accent: "#00ff00", motion: { captions: { in: "rise" } } },
        voice: { rate: "-5%" },
      },
    });
    const { sb } = await loadStoryboard(join(dir, "child.json"));
    expect(sb.source).toBe("child.mp4");
    expect(sb.keepSourceAudio).toBe(true);
    expect(sb.output).toEqual({ width: 1080, height: 1920, fps: 60 });
    expect(sb.theme.accent).toBe("#00ff00");
    expect(sb.theme.padding).toBe(0.1);
    expect(sb.theme.motion.captions).toEqual({ in: "rise", duration: 0.5 });
    expect(sb.voice).toMatchObject({ name: "ar-EG-SalmaNeural", rate: "-5%" });
    // Content is never inherited.
    expect(sb.captions).toEqual([]);
    expect(sb.zooms).toEqual([]);
    expect(sb.intro).toBeUndefined();
  });

  it("follows a chain of bases", async () => {
    const dir = await files({
      "a.json": { source: "a.mp4", theme: { accent: "#aaaaaa", radius: 4 }, output: { fps: 24 } },
      "b.json": { extends: "a.json", source: "b.mp4", theme: { accent: "#bbbbbb" } },
      "c/c.json": { extends: "../b.json", source: "c.mp4", output: { width: 1280, height: 720 } },
    });
    const { sb } = await loadStoryboard(join(dir, "c/c.json"));
    expect(sb.theme.accent).toBe("#bbbbbb");
    expect(sb.theme.radius).toBe(4);
    expect(sb.output).toEqual({ width: 1280, height: 720, fps: 24 });
  });

  it("names the files of a cycle", async () => {
    const dir = await files({
      "a.json": { extends: "b.json", source: "a.mp4" },
      "b.json": { extends: "a.json", source: "b.mp4" },
    });
    const err = await loadStoryboard(join(dir, "a.json")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect((err as Error).message).toMatch(/extends cycle: .*a\.json -> .*b\.json -> .*a\.json/);
  });

  it("says which base is missing and who extends it", async () => {
    const dir = await files({ "child.json": { extends: "nope.json", source: "c.mp4" } });
    const err = await loadStoryboard(join(dir, "child.json")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect((err as Error).message).toContain("nope.json");
    expect((err as Error).message).toContain("child.json");
  });

  it("rebases an inherited music path so it stays valid next to the child", async () => {
    const dir = await files({
      "brand/base.json": { source: "x.mp4", music: { src: "audio/bed.mp3", volume: 0.3 } },
      "demos/feature/child.json": { extends: "../../brand/base.json", source: "rec.mp4" },
      "demos/own.json": { extends: "../brand/base.json", source: "rec.mp4", music: { src: "mine.mp3" } },
    });
    const { sb } = await loadStoryboard(join(dir, "demos/feature/child.json"));
    expect(sb.music).toEqual({ src: "../../brand/audio/bed.mp3", volume: 0.3 });
    const own = await loadStoryboard(join(dir, "demos/own.json"));
    expect(own.sb.music).toEqual({ src: "mine.mp3", volume: 0.3 });
  });

  it("is documented in the JSON schema", () => {
    const schema = storyboardJsonSchema() as { properties: Record<string, { description?: string }> };
    expect(schema.properties.extends?.description).toMatch(/theme/);
  });
});
