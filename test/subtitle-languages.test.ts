import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CUE_RULES, shapeCues, toSrt } from "../src/render/subtitles.js";
import { cuesForLanguage, loadTranslation, parseSubtitleLanguages, writeTimelineSubtitles } from "../src/render/subtitle-langs.js";
import type { Timeline } from "../src/render/timeline.js";

const BIDI = /[‎‏‪-‮⁦-⁩؜]/;
const chars = (s: string) => [...s].length;

describe("shapeCues", () => {
  it("keeps a short cue as it is", () => {
    expect(shapeCues([{ start: 1, end: 3, text: "Open the settings." }])).toEqual([{ start: 1, end: 3, text: "Open the settings." }]);
  });

  it("wraps on spaces into at most 2 lines of about 42 characters, balanced", () => {
    const [c] = shapeCues([{ start: 0, end: 4, text: "Open the settings page and then press the save button now" }]);
    const lines = c!.text.split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(chars(l)).toBeLessThanOrEqual(42);
    expect(Math.abs(chars(lines[0]!) - chars(lines[1]!))).toBeLessThan(12);
    expect(lines.join(" ")).toBe("Open the settings page and then press the save button now");
  });

  it("never breaks a word, even one longer than the line", () => {
    const long = "x".repeat(60);
    const [c] = shapeCues([{ start: 0, end: 3, text: `${long} tail` }]);
    expect(c!.text.split("\n")[0]).toBe(long);
  });

  it("splits a 120 character Arabic line into cues of at most 2 lines each, with no bidi marks and no overlap", () => {
    const text = "مرحبا بكم في هذا الشرح المبسط لطريقة إعداد النظام وتشغيله للمرة الأولى على جهازك الجديد خطوة بخطوة وبدون أي تعقيد";
    expect(chars(text)).toBeGreaterThan(100);
    const out = shapeCues([{ start: 10, end: 16, text }]);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.text.split("\n").length).toBeLessThanOrEqual(2);
      for (const l of c.text.split("\n")) expect(chars(l)).toBeLessThanOrEqual(42);
      expect(c.text).not.toMatch(BIDI);
    }
    expect(out.map((c) => c.text).join(" ").replace(/\n/g, " ")).toBe(text);
    expect(out[0]!.start).toBe(10);
    expect(out.at(-1)!.end).toBeCloseTo(16, 3);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
  });

  it("does not add or remove bidi marks that are already in the text", () => {
    const text = "‏مرحبا بكم‏";
    expect(shapeCues([{ start: 0, end: 2, text }])[0]!.text).toBe(text);
  });

  it("trims a cue that would overlap the next one", () => {
    const out = shapeCues([
      { start: 0, end: 5, text: "one" },
      { start: 3, end: 6, text: "two" },
    ]);
    expect(out[0]!.end).toBe(3);
    expect(out[1]!.start).toBe(3);
  });

  it("stretches a very short cue to the minimum duration when the next cue leaves room", () => {
    const out = shapeCues([
      { start: 0, end: 0.1, text: "a" },
      { start: 5, end: 6, text: "b" },
    ]);
    expect(out[0]!.end - out[0]!.start).toBeCloseTo(DEFAULT_CUE_RULES.minDuration, 3);
  });

  it("honours a configured width and line count", () => {
    const out = shapeCues([{ start: 0, end: 6, text: "one two three four five six seven eight" }], { maxChars: 12, maxLines: 1 });
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) {
      expect(c.text).not.toContain("\n");
      expect(chars(c.text)).toBeLessThanOrEqual(12);
    }
  });

  it("keeps the lines the text already has", () => {
    expect(shapeCues([{ start: 0, end: 3, text: "English line\nسطر عربي" }])[0]!.text).toBe("English line\nسطر عربي");
  });
});

const timeline: Timeline = {
  version: 1,
  duration: 30,
  items: [
    { kind: "card", start: 0, end: 2, text: "Intro" },
    { kind: "narration", id: "a", start: 2, end: 4, text: "Hello.", part: 0, chapter: "setup" },
    { kind: "narration", id: "b", start: 5, end: 7, text: "World.", part: 0, chapter: "setup" },
    { kind: "narration", id: "0", start: 20, end: 22, text: "Next.", part: 1, chapter: "ops" },
  ],
};

async function tmp() {
  return mkdtemp(join(tmpdir(), "sp-sublang-"));
}

describe("parseSubtitleLanguages", () => {
  it("reads code and code=file entries", () => {
    expect(parseSubtitleLanguages("ar, en=en.json,es=/x/es.json")).toEqual([
      { code: "ar" },
      { code: "en", file: expect.stringMatching(/en\.json$/) },
      { code: "es", file: "/x/es.json" },
    ]);
  });

  it("reads an object (MCP) where auto means the video's own text", () => {
    expect(parseSubtitleLanguages({ ar: "auto", en: "/t/en.json" })).toEqual([{ code: "ar" }, { code: "en", file: "/t/en.json" }]);
  });

  it("rejects codes that cannot be part of a file name, and repeats", () => {
    expect(() => parseSubtitleLanguages("a/b")).toThrow(/language code/);
    expect(() => parseSubtitleLanguages("en,en")).toThrow(/twice/);
  });

  it("is empty for nothing", () => {
    expect(parseSubtitleLanguages(undefined)).toEqual([]);
  });
});

describe("cuesForLanguage", () => {
  it("uses the video's own text without a translation", () => {
    expect(cuesForLanguage(timeline).cues.map((c) => c.text)).toEqual(["Hello.", "World.", "Next."]);
  });

  it("looks lines up by id (flat map)", () => {
    const { cues } = cuesForLanguage(timeline, { a: "Hola.", b: "Mundo.", "0": "Siguiente." }, "es.json");
    expect(cues.map((c) => [c.start, c.text])).toEqual([[2, "Hola."], [5, "Mundo."], [20, "Siguiente."]]);
  });

  it("looks lines up by chapter, as an array or as an id map", () => {
    const { cues } = cuesForLanguage(timeline, { setup: ["Hola.", "Mundo."], ops: { "0": "Siguiente." } }, "es.json");
    expect(cues.map((c) => c.text)).toEqual(["Hola.", "Mundo.", "Siguiente."]);
  });

  it("fails with the chapter id and both counts when a chapter has the wrong number of lines", () => {
    expect(() => cuesForLanguage(timeline, { setup: ["Only one"], ops: ["x"] }, "es.json")).toThrow(/es\.json.*"setup".*1 line.*2/s);
    expect(() => cuesForLanguage(timeline, { setup: ["a", "b", "c"], ops: ["x"] }, "es.json")).toThrow(/"setup".*3 lines.*2/s);
  });

  it("fails naming the id when a line has no translation", () => {
    expect(() => cuesForLanguage(timeline, { a: "Hola." }, "es.json")).toThrow(/"b"/);
  });

  it("warns about keys that match nothing", () => {
    const r = cuesForLanguage(timeline, { a: "Hola.", b: "Mundo.", "0": "x", zzz: "?" }, "es.json");
    expect(r.warnings.join(" ")).toMatch(/zzz/);
  });

  it("uses the position when a narration item has no id", () => {
    const t: Timeline = { version: 1, duration: 9, items: [{ kind: "narration", start: 1, end: 2, text: "One" }, { kind: "narration", start: 3, end: 4, text: "Two" }] };
    expect(cuesForLanguage(t, { "0": "Uno", "1": "Dos" }, "x.json").cues.map((c) => c.text)).toEqual(["Uno", "Dos"]);
  });
});

describe("loadTranslation", () => {
  it("names the file when it is not a JSON object of lines", async () => {
    const dir = await tmp();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "[1,2]");
    await expect(loadTranslation(bad)).rejects.toThrow(/bad\.json/);
    await expect(loadTranslation(join(dir, "missing.json"))).rejects.toThrow(/missing\.json/);
  });
});

describe("writeTimelineSubtitles", () => {
  it("writes <output>.<code>.srt and .vtt per language, translated and shaped", async () => {
    const dir = await tmp();
    const es = join(dir, "es.json");
    await writeFile(es, JSON.stringify({ a: "Hola.", b: "Mundo.", "0": "Siguiente." }));
    const video = join(dir, "demo.mp4");
    const r = await writeTimelineSubtitles(timeline, video, { languages: parseSubtitleLanguages(`en,es=${es}`), formats: ["srt", "vtt"] });
    expect(r.files.map((f) => f.slice(dir.length + 1))).toEqual(["demo.en.srt", "demo.en.vtt", "demo.es.srt", "demo.es.vtt"]);
    expect(await readFile(join(dir, "demo.es.srt"), "utf8")).toBe(toSrt([{ start: 2, end: 4, text: "Hola." }, { start: 5, end: 7, text: "Mundo." }, { start: 20, end: 22, text: "Siguiente." }]));
    expect(await readFile(join(dir, "demo.en.vtt"), "utf8")).toMatch(/^WEBVTT\n\n00:00:02\.000 --> 00:00:04\.000\nHello\./);
  });

  it("writes the plain <output>.srt when no language is given", async () => {
    const dir = await tmp();
    const r = await writeTimelineSubtitles(timeline, join(dir, "demo.mp4"), { languages: [], formats: ["srt"] });
    expect(r.files.map((f) => f.slice(dir.length + 1))).toEqual(["demo.srt"]);
  });
});
