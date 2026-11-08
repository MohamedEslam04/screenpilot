import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStoryboard, loadStyle, StoryboardError } from "../src/storyboard/load.js";

async function files(tree: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-style-"));
  for (const [name, data] of Object.entries(tree)) {
    const p = join(dir, name);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, JSON.stringify(data));
  }
  return dir;
}

const base = {
  source: "rec.mp4",
  theme: { accent: "#ff0000", background: "#000000", css: ".card { color: red; }", fonts: ["Inter"], motion: { captions: { in: "pop", duration: 0.5 } } },
};

describe("loadStyle", () => {
  it("names the style after its file, reduced to a-z, 0-9 and dashes", async () => {
    const dir = await files({ "Brand B (dark).json": { theme: { accent: "#fff" } } });
    const s = await loadStyle(join(dir, "Brand B (dark).json"));
    expect(s.name).toBe("brand-b-dark");
    expect(s.path).toBe(join(dir, "Brand B (dark).json"));
    expect(s.theme).toEqual({ accent: "#fff" });
  });

  it("keeps only what the file sets (no schema defaults leak in)", async () => {
    const dir = await files({ "s.json": { theme: { grade: { saturation: 1.2 } } } });
    expect((await loadStyle(join(dir, "s.json"))).theme).toEqual({ grade: { saturation: 1.2 } });
  });

  it("rejects keys other than theme, naming them", async () => {
    const dir = await files({ "s.json": { theme: { accent: "#fff" }, voice: { name: "x" }, output: { width: 10 } } });
    const err = await loadStyle(join(dir, "s.json")).catch((e) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect(err.message).toMatch(/voice/);
    expect(err.message).toMatch(/output/);
  });

  it("rejects a theme key that does not exist (a typo would silently do nothing)", async () => {
    const dir = await files({ "s.json": { theme: { acent: "#fff" } } });
    await expect(loadStyle(join(dir, "s.json"))).rejects.toThrow(/acent/);
  });

  it("rejects a wrong theme value", async () => {
    const dir = await files({ "s.json": { theme: { padding: 5 } } });
    await expect(loadStyle(join(dir, "s.json"))).rejects.toThrow(/padding/);
  });

  it("needs a theme", async () => {
    const dir = await files({ "s.json": {} });
    await expect(loadStyle(join(dir, "s.json"))).rejects.toThrow(/theme/);
  });

  it("names the path of a missing file", async () => {
    const dir = await files({});
    const p = join(dir, "missing.json");
    await expect(loadStyle(p)).rejects.toThrow(p);
  });
});

describe("loadStoryboard with a style", () => {
  it("changes accent and keeps the storyboard's other theme values", async () => {
    const dir = await files({ "sb.json": base, "s.json": { theme: { accent: "#00ff00" } } });
    const style = await loadStyle(join(dir, "s.json"));
    const { sb } = await loadStoryboard(join(dir, "sb.json"), { style });
    expect(sb.theme.accent).toBe("#00ff00");
    expect(sb.theme.background).toBe("#000000");
  });

  it("merges motion key by key", async () => {
    const dir = await files({ "sb.json": base, "s.json": { theme: { motion: { captions: { in: "rise" }, cards: { in: "fade" } } } } });
    const { sb } = await loadStoryboard(join(dir, "sb.json"), { style: await loadStyle(join(dir, "s.json")) });
    expect(sb.theme.motion.captions).toMatchObject({ in: "rise", duration: 0.5 });
    expect(sb.theme.motion.cards).toMatchObject({ in: "fade" });
  });

  it("replaces css and fonts instead of merging them", async () => {
    const dir = await files({ "sb.json": base, "s.json": { theme: { css: ".text { color: blue; }", fonts: ["Cairo"] } } });
    const { sb } = await loadStoryboard(join(dir, "sb.json"), { style: await loadStyle(join(dir, "s.json")) });
    expect(sb.theme.css).toBe(".text { color: blue; }");
    expect(sb.theme.fonts).toEqual(["Cairo"]);
  });

  it("applies over a theme inherited through extends", async () => {
    const dir = await files({
      "base.json": { source: "rec.mp4", theme: { accent: "#111111", padding: 0.1 } },
      "sb.json": { extends: "base.json", source: "rec.mp4" },
      "s.json": { theme: { accent: "#222222" } },
    });
    const { sb } = await loadStoryboard(join(dir, "sb.json"), { style: await loadStyle(join(dir, "s.json")) });
    expect(sb.theme).toMatchObject({ accent: "#222222", padding: 0.1 });
  });

  it("is unchanged without a style", async () => {
    const dir = await files({ "sb.json": base });
    const { sb } = await loadStoryboard(join(dir, "sb.json"));
    expect(sb.theme.accent).toBe("#ff0000");
  });
});
