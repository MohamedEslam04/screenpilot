import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/render/plan.js";
import { assertTimelineFresh, buildOutputTimeline, joinTimelines, readTimeline, timelinePath, TimelineSchema, writeTimeline, type Timeline } from "../src/render/timeline.js";
import { windowPlan } from "../src/render/window.js";
import { lintStoryboard } from "../src/storyboard/load.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const clip = (at: number, text: string, duration: number, id?: string) => ({ at, text, caption: true, duration, file: "x", voice: "v", rate: "+0%", src: `voice/${at}.mp3`, ...(id ? { id } : {}) });

/** 3 narration lines (source 2, 8, 15) and a 3 s hold at source 5; an intro of 2 s and an outro. */
function planOf(extra: Record<string, unknown> = {}) {
  const sb = StoryboardSchema.parse({ source: "r.mp4", intro: { title: "Hi", dur: 2 }, outro: { title: "Bye", subtitle: "See you", dur: 2 }, ...extra });
  const holds = [{ at: 5, dur: 3 }];
  const timeline = buildTimeline({ segments: sb.segments, holds, sourceDuration: 20, offset: sb.intro?.dur ?? 0 });
  const plan = buildPlan({
    sb,
    timeline,
    editedSrc: "e.mp4",
    editedHasAudio: false,
    source: { width: 1920, height: 1080 },
    narration: [clip(2, "One.", 1.5, "a"), clip(8, "Two.", 2), clip(15, "Three.", 1)],
    clicks: [],
  });
  return { sb, plan };
}

describe("buildOutputTimeline", () => {
  it("puts narration in output seconds, including the intro and the hold before the line", () => {
    const { sb, plan } = planOf();
    const tl = buildOutputTimeline(plan, { outro: sb.outro });
    const narration = tl.items.filter((i) => i.kind === "narration");
    // intro 2 s; source 2 -> 4; the 3 s hold at source 5 pushes source 8 to 2 + 8 + 3 = 13, source 15 to 20.
    expect(narration.map((i) => [i.start, i.end, i.text])).toEqual([
      [4, 5.5, "One."],
      [13, 15, "Two."],
      [20, 21, "Three."],
    ]);
  });

  it("uses the line's id, else its index, so translations survive reordering", () => {
    const { sb, plan } = planOf();
    const tl = buildOutputTimeline(plan, { outro: sb.outro });
    expect(tl.items.filter((i) => i.kind === "narration").map((i) => i.id)).toEqual(["a", undefined, undefined]);
  });

  it("lists the intro as a card and the outro as an outro, with title and subtitle", () => {
    const { sb, plan } = planOf();
    const tl = buildOutputTimeline(plan, { outro: sb.outro });
    expect(tl.items.filter((i) => i.kind !== "narration").map((i) => [i.kind, i.text])).toEqual([
      ["card", "Hi"],
      ["outro", "Bye\nSee you"],
    ]);
    expect(tl.duration).toBe(plan.duration);
    expect(tl.items.map((i) => i.start)).toEqual([...tl.items.map((i) => i.start)].sort((a, b) => a - b));
  });

  it("follows a partial render", () => {
    const { sb, plan } = planOf();
    const tl = buildOutputTimeline(windowPlan(plan, { from: 3, to: 14 }), { outro: sb.outro });
    expect(tl.duration).toBe(11);
    expect(tl.items.filter((i) => i.kind === "narration").map((i) => [i.start, i.end])).toEqual([
      [1, 2.5],
      [10, 11],
    ]);
  });

  it("round-trips through the schema and a file next to the video", async () => {
    const { sb, plan } = planOf();
    const tl = buildOutputTimeline(plan, { outro: sb.outro });
    const dir = await mkdtemp(join(tmpdir(), "sp-timeline-"));
    const file = timelinePath(join(dir, "demo.mp4"));
    expect(file).toBe(join(dir, "demo.timeline.json"));
    await writeTimeline(file, tl);
    expect(await readTimeline(file)).toEqual(TimelineSchema.parse(tl));
  });

  it("names the file when it cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-timeline-"));
    const file = join(dir, "bad.timeline.json");
    await writeFile(file, JSON.stringify({ duration: "long" }));
    await expect(readTimeline(file)).rejects.toThrow(file);
    await expect(readTimeline(join(dir, "missing.timeline.json"))).rejects.toThrow(/missing\.timeline\.json/);
  });
});

describe("assertTimelineFresh", () => {
  const tl: Timeline = { version: 1, duration: 10, items: [] };

  it("accepts a video within 0.25 s", () => {
    expect(() => assertTimelineFresh("a.timeline.json", tl, 10.2)).not.toThrow();
    expect(() => assertTimelineFresh("a.timeline.json", tl, 9.8)).not.toThrow();
  });

  it("is an error that names the file when the video is longer or shorter by more", () => {
    expect(() => assertTimelineFresh("/x/a.timeline.json", tl, 10.3)).toThrow(/\/x\/a\.timeline\.json.*10\.3/);
    expect(() => assertTimelineFresh("/x/a.timeline.json", tl, 9.7)).toThrow(/\/x\/a\.timeline\.json/);
  });
});

describe("joinTimelines", () => {
  const part = (duration: number, texts: string[], more: Partial<Timeline["items"][number]> = {}): Timeline => ({
    version: 1,
    duration,
    items: texts.map((text, i) => ({ kind: "narration" as const, id: String(i), start: 1 + i, end: 2 + i, text, ...more })),
  });
  const starts = (tl: Timeline) => tl.items.map((i) => [i.text, i.start, i.end]);

  it("subtracts each transition's dur from the start of every later part (3 parts, 2 transitions of different dur)", () => {
    const tl = joinTimelines(
      [
        { timeline: part(10, ["a"]), duration: 10 },
        { timeline: part(8, ["b"]), duration: 8, transition: { type: "crossfade", dur: 0.5 } },
        { timeline: part(6, ["c"]), duration: 6, transition: { type: "fade-black", dur: 1 } },
      ],
      25,
    );
    // part starts: 0, 10 - 0.5, 10 + 8 - 0.5 - 1 = 16.5
    expect(starts(tl)).toEqual([
      ["a", 1, 2],
      ["b", 10.5, 11.5],
      ["c", 17.5, 18.5],
    ]);
    expect(tl.duration).toBe(22.5);
  });

  it("clamps a transition to half of either neighbour, like the join does, and treats a cut as no overlap", () => {
    const tl = joinTimelines(
      [
        { timeline: part(10, ["a"]), duration: 10 },
        { timeline: part(2, ["b"]), duration: 2, transition: { type: "crossfade", dur: 5 } },
        { timeline: part(4, ["c"]), duration: 4, transition: { type: "cut", dur: 3 } },
      ],
      25,
    );
    // b: dur clamped to 1 (half of b); starts at 9. c: a cut, starts at 9 + 2.
    expect(starts(tl)).toEqual([
      ["a", 1, 2],
      ["b", 10, 11],
      ["c", 12, 13],
    ]);
    expect(tl.duration).toBe(15);
  });

  it("joins two finished videos' timelines", () => {
    const tl = joinTimelines(
      [
        { timeline: part(5, ["a", "b"]), duration: 5 },
        { timeline: part(4, ["c"]), duration: 4, transition: { type: "crossfade", dur: 0.6 } },
      ],
      30,
    );
    expect(starts(tl)).toEqual([
      ["a", 1, 2],
      ["b", 2, 3],
      ["c", 5.4, 6.4],
    ]);
    expect(tl.duration).toBe(8.4);
  });

  it("uses the real part length, not the one in the part's timeline, for the offsets", () => {
    const tl = joinTimelines(
      [
        { timeline: part(10, ["a"]), duration: 10.08 },
        { timeline: part(8, ["b"]), duration: 8 },
      ],
      25,
    );
    expect(tl.items[1]!.start).toBeCloseTo(11.08, 6);
  });

  it("numbers the parts, keeps a chapter the part brought and gives its own to the rest", () => {
    const tl = joinTimelines(
      [
        { timeline: part(5, ["a"], { chapter: "inner" }), duration: 5, part: 0 },
        { timeline: part(5, ["b"]), duration: 5, chapter: "setup" },
      ],
      25,
    );
    expect(tl.items.map((i) => [i.part, i.chapter])).toEqual([
      [0, "inner"],
      [1, "setup"],
    ]);
  });
});

describe("narration id", () => {
  it("is optional and kept", () => {
    expect(StoryboardSchema.parse({ source: "r.mp4", narration: [{ at: 1, text: "x", id: "intro" }, { at: 2, text: "y" }] }).narration.map((n) => n.id)).toEqual(["intro", undefined]);
  });

  it("warns about a duplicate id", () => {
    const sb = StoryboardSchema.parse({ source: "r.mp4", narration: [{ at: 1, text: "x", id: "a" }, { at: 2, text: "y", id: "a" }] });
    expect(lintStoryboard(sb).join("\n")).toMatch(/narration\[1\].*"a".*narration\[0\]/);
  });

  it("is on the plan's subtitle cues only when given, so subtitle files do not change", () => {
    const { plan } = planOf();
    expect(plan.subtitles.map((s) => s.id)).toEqual(["a", undefined, undefined]);
  });
});

it("writes the file with a trailing newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-timeline-"));
  const file = join(dir, "t.timeline.json");
  await writeTimeline(file, { version: 1, duration: 1, items: [] });
  expect((await readFile(file, "utf8")).endsWith("}\n")).toBe(true);
});
