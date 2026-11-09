import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStoryboard, StoryboardError } from "../src/storyboard/load.js";
import { loadVariant } from "../src/storyboard/variant.js";

async function files(tree: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-variant-"));
  for (const [name, data] of Object.entries(tree)) {
    const p = join(dir, name);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, JSON.stringify(data));
  }
  return dir;
}

const base = {
  source: "rec.mp4",
  voice: { name: "ar-EG-SalmaNeural", rate: "+5%", gap: 0.4 },
  zooms: [{ at: 1, dur: 2, x: 0.5, y: 0.5, scale: 2 }],
  overlays: [{ src: "logo-eg.png", x: 0.8, y: 0.05, w: 0.15, h: 0.1 }],
  narration: [
    { at: 0, text: "one", id: "intro" },
    { at: 4, text: "two" },
    { at: 8, text: "three", voice: "ar-EG-ShakirNeural" },
  ],
};

describe("loadVariant", () => {
  it("looks a name up as variants/<name>.json next to the storyboard", async () => {
    const dir = await files({ "demo.json": base, "variants/saudi.json": { narration: { intro: "x" } } });
    const v = await loadVariant("saudi", join(dir, "demo.json"));
    expect(v.path).toBe(join(dir, "variants", "saudi.json"));
    expect(v.name).toBe("saudi");
    expect(v.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("takes a file path as it is and names it after the file", async () => {
    const dir = await files({ "demo.json": base, "other/Saudi Female.json": { voice: { name: "x" } } });
    const v = await loadVariant(join(dir, "other", "Saudi Female.json"), join(dir, "demo.json"));
    expect(v.name).toBe("saudi-female");
  });

  it("changes the hash when the file changes", async () => {
    const a = await files({ "v.json": { narration: { "0": "a" } } });
    const b = await files({ "v.json": { narration: { "0": "b" } } });
    expect((await loadVariant(join(a, "v.json"), join(a, "d.json"))).hash).not.toBe((await loadVariant(join(b, "v.json"), join(b, "d.json"))).hash);
  });

  it("says where it looked when the file is missing", async () => {
    const dir = await files({ "demo.json": base });
    await expect(loadVariant("nope", join(dir, "demo.json"))).rejects.toThrow(/variants[\\/]nope\.json/);
  });

  it("rejects keys it does not know, naming them (cards are not supported yet)", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { narration: { intro: "x" }, cards: {}, theme: {} } });
    const err = await loadVariant("v", join(dir, "demo.json")).catch((e) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect(err.message).toMatch(/cards/);
    expect(err.message).toMatch(/theme/);
  });
});

describe("loadStoryboard with a variant", () => {
  it("replaces narration text by id or position and the voice, and nothing else", async () => {
    const dir = await files({
      "demo.json": base,
      "variants/saudi.json": { voice: { name: "ar-SA-HamedNeural" }, narration: { intro: "واحد", "1": "اثنين", "2": "ثلاثة" } },
    });
    const plain = await loadStoryboard(join(dir, "demo.json"));
    const v = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("saudi", join(dir, "demo.json")) });
    expect(v.sb.narration.map((n) => n.text)).toEqual(["واحد", "اثنين", "ثلاثة"]);
    expect(v.sb.voice).toEqual({ ...plain.sb.voice, name: "ar-SA-HamedNeural" });

    // Everything else is byte-identical.
    const strip = (sb: typeof plain.sb) => ({ ...sb, voice: undefined, narration: sb.narration.map(({ text: _t, ...rest }) => rest) });
    expect(JSON.stringify(strip(v.sb))).toBe(JSON.stringify(strip(plain.sb)));
  });

  it("without a variant the result is exactly what it was", async () => {
    const dir = await files({ "demo.json": base });
    const a = await loadStoryboard(join(dir, "demo.json"));
    const b = await loadStoryboard(join(dir, "demo.json"), {});
    expect(JSON.stringify(b.sb)).toBe(JSON.stringify(a.sb));
  });

  it("a partial variant keeps the lines it does not name", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { narration: { "1": "changed" } } });
    const v = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) });
    expect(v.sb.narration.map((n) => n.text)).toEqual(["one", "changed", "three"]);
  });

  it("an array covers every line in order", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { narration: ["a", "b", "c"] } });
    const v = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) });
    expect(v.sb.narration.map((n) => n.text)).toEqual(["a", "b", "c"]);
  });

  it("fails with both counts when an array has another number of lines", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { narration: ["a", "b", "c", "d"] } });
    const err = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) }).catch((e) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect(err.message).toMatch(/4 line\(s\)/);
    expect(err.message).toMatch(/3 line\(s\)/);
  });

  it("fails with both counts and the unknown keys when a record names lines that do not exist", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { narration: { intro: "a", "7": "b", extra: "c" } } });
    const err = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) }).catch((e) => e);
    expect(err).toBeInstanceOf(StoryboardError);
    expect(err.message).toMatch(/3 line\(s\)/); // the variant names 3
    expect(err.message).toMatch(/storyboard has 3 line\(s\)/);
    expect(err.message).toMatch(/"7"/);
    expect(err.message).toMatch(/"extra"/);
  });

  it("applies after extends and a style, so a base's voice is replaced too", async () => {
    const dir = await files({
      "base.json": { source: "x.mp4", voice: { name: "base-voice", rate: "+10%" } },
      "demo.json": { source: "rec.mp4", extends: "base.json", narration: [{ at: 0, text: "one" }] },
      "variants/v.json": { voice: { name: "variant-voice" } },
    });
    const v = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) });
    expect(v.sb.voice).toMatchObject({ name: "variant-voice", rate: "+10%" });
  });

  it("replaces an overlay's file by its position", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { overlays: { "0": { src: "logo-sa.png" } } } });
    const v = await loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) });
    expect(v.sb.overlays[0]).toMatchObject({ src: "logo-sa.png", x: 0.8, w: 0.15 });
  });

  it("fails when an overlay position does not exist", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { overlays: { "3": { src: "x.png" } } } });
    await expect(loadStoryboard(join(dir, "demo.json"), { variant: await loadVariant("v", join(dir, "demo.json")) })).rejects.toThrow(/overlays/);
  });

  it("rejects a voice key that does not exist", async () => {
    const dir = await files({ "demo.json": base, "variants/v.json": { voice: { nmae: "x" } } });
    await expect(loadVariant("v", join(dir, "demo.json"))).rejects.toThrow(/nmae/);
  });
});
