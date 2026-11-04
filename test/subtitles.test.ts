import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/render/plan.js";
import { parseSubtitleFormats, toSrt, toVtt, writeSubtitles } from "../src/render/subtitles.js";
import { windowPlan } from "../src/render/window.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const cues = [
  { start: 1.2, end: 3.45, text: "Open the settings." },
  { start: 3725.5, end: 3727, text: "An hour in\nsecond line" },
];

describe("toSrt", () => {
  it("numbers the cues and writes times as HH:MM:SS,mmm", () => {
    expect(toSrt(cues)).toBe("1\n00:00:01,200 --> 00:00:03,450\nOpen the settings.\n\n2\n01:02:05,500 --> 01:02:07,000\nAn hour in\nsecond line\n");
  });

  it("sorts by time, drops empty text, keeps every cue at least a frame long and cleans blank lines", () => {
    const out = toSrt([
      { start: 5, end: 5, text: "later" },
      { start: 1, end: 2, text: "  " },
      { start: 2, end: 4, text: "first\n\nafter a blank" },
    ]);
    expect(out).toBe("1\n00:00:02,000 --> 00:00:04,000\nfirst\nafter a blank\n\n2\n00:00:05,000 --> 00:00:05,040\nlater\n");
  });

  it("is empty for no cues", () => {
    expect(toSrt([])).toBe("");
  });
});

describe("toVtt", () => {
  it("starts with WEBVTT and writes times as HH:MM:SS.mmm", () => {
    expect(toVtt(cues)).toBe("WEBVTT\n\n00:00:01.200 --> 00:00:03.450\nOpen the settings.\n\n01:02:05.500 --> 01:02:07.000\nAn hour in\nsecond line\n");
  });

  it("escapes what WebVTT treats as markup", () => {
    expect(toVtt([{ start: 0, end: 1, text: "a <b> & c --> d" }])).toContain("a &lt;b&gt; &amp; c --&gt; d");
  });

  it("is just the header for no cues", () => {
    expect(toVtt([])).toBe("WEBVTT\n");
  });
});

describe("parseSubtitleFormats", () => {
  it("reads a comma list, once each", () => {
    expect(parseSubtitleFormats("srt,vtt")).toEqual(["srt", "vtt"]);
    expect(parseSubtitleFormats(" VTT , srt,srt ")).toEqual(["vtt", "srt"]);
    expect(parseSubtitleFormats(["srt"])).toEqual(["srt"]);
    expect(parseSubtitleFormats(undefined)).toEqual([]);
  });

  it("rejects anything else", () => {
    expect(() => parseSubtitleFormats("srt,ass")).toThrow(/ass/);
  });
});

describe("writeSubtitles", () => {
  it("writes next to the video, named after it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-subs-"));
    const files = await writeSubtitles(cues, join(dir, "demo.mp4"), ["srt", "vtt"]);
    expect(files).toEqual([join(dir, "demo.srt"), join(dir, "demo.vtt")]);
    expect(await readFile(files[0]!, "utf8")).toBe(toSrt(cues));
    expect((await readFile(files[1]!, "utf8")).startsWith("WEBVTT")).toBe(true);
  });

  it("writes nothing when no format is asked for", async () => {
    expect(await writeSubtitles(cues, "/nowhere/demo.mp4", [])).toEqual([]);
  });
});

function planOf(extra: Record<string, unknown>) {
  const sb = StoryboardSchema.parse({ source: "r.mp4", ...extra });
  const timeline = buildTimeline({ segments: sb.segments, holds: [], sourceDuration: 20, offset: sb.intro?.dur ?? 0 });
  const clip = (at: number, text: string, duration: number, caption = true) => ({ at, text, caption, duration, file: "x", voice: "v", rate: "+0%", src: `voice/${at}.mp3` });
  return buildPlan({
    sb,
    timeline,
    editedSrc: "e.mp4",
    editedHasAudio: false,
    source: { width: 1920, height: 1080 },
    narration: [clip(2, "Open it.", 1.5), clip(8, "Not on screen.", 2, false), clip(15, "In a cut.", 1)],
    clicks: [],
  });
}

describe("subtitles in the plan", () => {
  it("has one cue per narration line, in output time, even when the line is not burned in", () => {
    const p = planOf({ intro: { title: "Hi", dur: 2 } });
    expect(p.subtitles).toEqual([
      { start: 4, end: 5.5, text: "Open it." },
      { start: 10, end: 12, text: "Not on screen." },
      { start: 17, end: 18, text: "In a cut." },
    ]);
  });

  it("drops a line in a cut region", () => {
    const p = planOf({ segments: [{ in: 0, out: 10 }] });
    expect(p.subtitles.map((c) => c.text)).toEqual(["Open it.", "Not on screen."]);
  });

  it("has none without narration", () => {
    const sb = StoryboardSchema.parse({ source: "r.mp4" });
    const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 20 });
    expect(buildPlan({ sb, timeline, editedSrc: "e", editedHasAudio: false, source: { width: 1, height: 1 }, narration: [], clicks: [] }).subtitles).toEqual([]);
  });

  it("follows a partial render: shifted to the window, cut at its edges", () => {
    const w = windowPlan(planOf({}), { from: 1, to: 9 });
    expect(w.subtitles).toEqual([
      { start: 1, end: 2.5, text: "Open it." },
      { start: 7, end: 8, text: "Not on screen." },
    ]);
    const mid = windowPlan(planOf({}), { from: 2.5, to: 20 });
    expect(mid.subtitles[0]).toEqual({ start: 0, end: 1, text: "Open it." });
  });
});
