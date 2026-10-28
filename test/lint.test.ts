import { describe, expect, it } from "vitest";
import { lintStyle, lintTimeline } from "../src/storyboard/lint.js";
import { lintStoryboard } from "../src/storyboard/load.js";
import { type StoryboardInput, StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("lintStyle", () => {
  const cases: { name: string; sb: Partial<StoryboardInput>; expected: RegExp[] }[] = [
    { name: "clean storyboard", sb: {}, expected: [] },
    { name: "12-word narration is fine", sb: { narration: [{ at: 0, text: words(12) }] }, expected: [] },
    { name: "13-word narration", sb: { narration: [{ at: 0, text: words(13) }] }, expected: [/narration\[0\].*13 words/] },
    {
      name: "narration pace too fast for the gap to the next line",
      sb: {
        narration: [
          { at: 0, text: words(10) },
          { at: 2, text: "ok" },
        ],
      },
      expected: [/narration\[0\].*10 words.*2\.0s.*freez/],
    },
    {
      name: "pace uses time order, not array order",
      sb: {
        narration: [
          { at: 10, text: "ok" },
          { at: 0, text: words(10) },
        ],
      },
      expected: [], // 10 words over a 10s gap
    },
    { name: "last narration line has no slot to check", sb: { narration: [{ at: 0, text: words(11) }] }, expected: [] },
    { name: "caption of 7 words", sb: { captions: [{ at: 0, text: words(7) }] }, expected: [/captions\[0\].*7 words/] },
    { name: "caption of 6 words", sb: { captions: [{ at: 0, text: words(6) }] }, expected: [] },
    {
      name: "overlapping captions in the same position",
      sb: {
        captions: [
          { at: 0, dur: 3, text: "a" },
          { at: 2, dur: 3, text: "b" },
        ],
      },
      expected: [/captions\[1\].*captions\[0\].*bottom/],
    },
    {
      name: "overlapping captions in different positions",
      sb: {
        captions: [
          { at: 0, dur: 3, text: "a" },
          { at: 2, dur: 3, text: "b", position: "top" },
        ],
      },
      expected: [],
    },
    {
      name: "back to back captions",
      sb: {
        captions: [
          { at: 0, dur: 3, text: "a" },
          { at: 3, dur: 3, text: "b" },
        ],
      },
      expected: [],
    },
    {
      name: "callouts anchor to their own point, so they may overlap",
      sb: {
        captions: [
          { at: 0, dur: 3, text: "a", style: "callout", x: 0.2, y: 0.2 },
          { at: 1, dur: 3, text: "b", style: "callout", x: 0.8, y: 0.8 },
        ],
      },
      expected: [],
    },
    {
      name: "overlapping zooms",
      sb: {
        zooms: [
          { at: 1, dur: 3, x: 0.5, y: 0.5, scale: 1.8 },
          { at: 3, dur: 2, x: 0.2, y: 0.2, scale: 1.8 },
        ],
      },
      expected: [/zooms\[1\].*zooms\[0\]/],
    },
    {
      name: "separate zooms",
      sb: {
        zooms: [
          { at: 1, dur: 2, x: 0.5, y: 0.5, scale: 1.8 },
          { at: 3, dur: 2, x: 0.2, y: 0.2, scale: 1.8 },
        ],
      },
      expected: [],
    },
    { name: "zoom scale too small", sb: { zooms: [{ at: 1, dur: 2, x: 0.5, y: 0.5, scale: 1.2 }] }, expected: [/zooms\[0\].*1\.2.*1\.4.*2\.5/] },
    { name: "zoom scale too large", sb: { zooms: [{ at: 1, dur: 2, x: 0.5, y: 0.5, scale: 3 }] }, expected: [/zooms\[0\].*scale 3/] },
    {
      name: "zoom scale at the edges",
      sb: {
        zooms: [
          { at: 1, dur: 1, x: 0.5, y: 0.5, scale: 1.4 },
          { at: 5, dur: 1, x: 0.5, y: 0.5, scale: 2.5 },
        ],
      },
      expected: [],
    },
    {
      name: "zoom + highlight + callout stacked on one point",
      sb: {
        zooms: [{ at: 5, dur: 2, x: 0.5, y: 0.5, scale: 1.8 }],
        highlights: [{ at: 5.5, dur: 2, x: 0.45, y: 0.45, w: 0.1, h: 0.1 }],
        captions: [{ at: 5.2, dur: 2, text: "Click", style: "callout", x: 0.52, y: 0.5 }],
      },
      expected: [/zooms\[0\].*highlights\[0\].*captions\[0\].*stack/],
    },
    {
      name: "zoom + highlight only is allowed",
      sb: {
        zooms: [{ at: 5, dur: 2, x: 0.5, y: 0.5, scale: 1.8 }],
        highlights: [{ at: 5.5, dur: 2, x: 0.45, y: 0.45, w: 0.1, h: 0.1 }],
      },
      expected: [],
    },
    {
      name: "stack on different points is allowed",
      sb: {
        zooms: [{ at: 5, dur: 2, x: 0.5, y: 0.5, scale: 1.8 }],
        highlights: [{ at: 5.5, dur: 2, x: 0.05, y: 0.05, w: 0.1, h: 0.1 }],
        captions: [{ at: 5.2, dur: 2, text: "Click", style: "callout", x: 0.9, y: 0.9 }],
      },
      expected: [],
    },
    {
      name: "stack far apart in time is allowed",
      sb: {
        zooms: [{ at: 5, dur: 1, x: 0.5, y: 0.5, scale: 1.8 }],
        highlights: [{ at: 9, dur: 2, x: 0.45, y: 0.45, w: 0.1, h: 0.1 }],
        captions: [{ at: 13, dur: 2, text: "Click", style: "callout", x: 0.5, y: 0.5 }],
      },
      expected: [],
    },
    { name: "segment faster than 8x", sb: { segments: [{ in: 0, out: 10, speed: 12 }] }, expected: [/segments\[0\].*12x.*8x/] },
    { name: "segment at 8x", sb: { segments: [{ in: 0, out: 10, speed: 8 }] }, expected: [] },
  ];

  it.each(cases)("$name", ({ sb, expected }) => {
    const out = lintStyle(StoryboardSchema.parse({ source: "a.mp4", ...sb }));
    expect(out).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(out[i]).toMatch(e));
  });

  it("is part of lintStoryboard", () => {
    const out = lintStoryboard(StoryboardSchema.parse({ source: "a.mp4", captions: [{ at: 0, text: words(8) }] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/captions\[0\]/);
  });
});

describe("lintTimeline", () => {
  const tl = (dur: number, offset = 0) => buildTimeline({ segments: [], holds: [], sourceDuration: dur, offset });
  const sbOf = (extra: Partial<StoryboardInput>) => StoryboardSchema.parse({ source: "a.mp4", ...extra });

  it.each<{ name: string; dur: number; sb: Partial<StoryboardInput>; expected: RegExp[] }>([
    { name: "in range", dur: 45, sb: {}, expected: [] },
    { name: "too long", dur: 120, sb: {}, expected: [/120\.0s.*over 90s/] },
    { name: "too short", dur: 8, sb: {}, expected: [/8\.0s.*under 15s/] },
    { name: "outro counts", dur: 12, sb: { outro: { title: "Bye", dur: 4 } }, expected: [] },
    { name: "exactly 90s", dur: 90, sb: {}, expected: [] },
  ])("$name", ({ dur, sb, expected }) => {
    const out = lintTimeline(sbOf(sb), tl(dur));
    expect(out).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(out[i]).toMatch(e));
  });

  it("counts the intro offset", () => {
    expect(lintTimeline(sbOf({ intro: { title: "Hi", dur: 3 } }), tl(13, 3))).toEqual([]);
  });
});

describe("lintStoryboard cards", () => {
  const sb = (cards: unknown[]) =>
    StoryboardSchema.parse({ source: "a.mp4", segments: [{ in: 0, out: 10 }, { in: 20, out: 30 }], cards });

  it("warns when a card sits in a cut region", () => {
    expect(lintStoryboard(sb([{ at: 15, title: "Step" }]), 40)).toContainEqual(expect.stringMatching(/cards\[0\].*cut/));
  });

  it("is quiet when the card is inside a segment", () => {
    expect(lintStoryboard(sb([{ at: 5, title: "Step" }]), 40).filter((w) => w.startsWith("cards["))).toEqual([]);
  });
});
