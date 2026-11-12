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

describe("lint rule ids and limits", () => {
  const sbOf = (extra: Record<string, unknown>) => StoryboardSchema.parse({ source: "a.mp4", ...extra });
  const tl = (dur: number) => buildTimeline({ segments: [], holds: [], sourceDuration: dur, offset: 0 });

  it.each<{ id: string; sb: Record<string, unknown> }>([
    { id: "narration-length", sb: { narration: [{ at: 0, text: words(15) }] } },
    {
      id: "narration-speed",
      sb: {
        narration: [
          { at: 0, text: words(10) },
          { at: 2, text: "ok" },
        ],
      },
    },
    { id: "caption-length", sb: { captions: [{ at: 0, text: words(8) }] } },
    { id: "zoom-scale", sb: { zooms: [{ at: 1, dur: 2, x: 0.5, y: 0.5, scale: 3 }] } },
    {
      id: "stack",
      sb: {
        zooms: [{ at: 5, dur: 2, x: 0.5, y: 0.5, scale: 1.8 }],
        highlights: [{ at: 5.5, dur: 2, x: 0.45, y: 0.45, w: 0.1, h: 0.1 }],
        captions: [{ at: 5.2, dur: 2, text: "Click", style: "callout", x: 0.52, y: 0.5 }],
      },
    },
    { id: "transition", sb: { segments: [{ in: 0, out: 10, transition: { type: "crossfade", dur: 0.5 } }] } },
  ])("$id warning is prefixed with its id and can be turned off", ({ id, sb }) => {
    const out = lintStyle(sbOf(sb));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(new RegExp(`^\\[${id}\\] `));
    expect(lintStyle(sbOf({ ...sb, lint: { off: [id] } }))).toEqual([]);
  });

  it("prefixes the duration warning and off silences it", () => {
    expect(lintTimeline(sbOf({}), tl(120))[0]).toMatch(/^\[duration\] /);
    expect(lintTimeline(sbOf({ lint: { off: ["duration"] } }), tl(120))).toEqual([]);
    expect(lintTimeline(sbOf({ lint: { off: ["duration"] } }), tl(5))).toEqual([]);
  });

  it("narrationWords raises the limit", () => {
    const narration = [{ at: 0, text: words(15) }];
    expect(lintStyle(sbOf({ narration }))).toHaveLength(1);
    expect(lintStyle(sbOf({ narration, lint: { narrationWords: 20 } }))).toEqual([]);
    expect(lintStyle(sbOf({ narration, lint: { narrationWords: 10 } }))[0]).toMatch(/15 words \(over 10\)/);
  });

  it("captionWords raises the limit", () => {
    const captions = [{ at: 0, text: words(8) }];
    expect(lintStyle(sbOf({ captions, lint: { captionWords: 8 } }))).toEqual([]);
  });

  it("duration min and max replace the defaults", () => {
    expect(lintTimeline(sbOf({ lint: { duration: { max: 200 } } }), tl(120))).toEqual([]);
    expect(lintTimeline(sbOf({ lint: { duration: { max: 200 } } }), tl(8))[0]).toMatch(/under 15s/);
    expect(lintTimeline(sbOf({ lint: { duration: { min: 5 } } }), tl(8))).toEqual([]);
    expect(lintTimeline(sbOf({ lint: { duration: { min: 5, max: 100 } } }), tl(120))[0]).toMatch(/over 100s/);
  });

  it("rejects an unknown rule id in off", () => {
    expect(StoryboardSchema.safeParse({ source: "a.mp4", lint: { off: ["nope"] } }).success).toBe(false);
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

describe("[annotation-outside]", () => {
  const blur = (at: number, dur: number, mode: "blur" | "solid" = "solid") => ({ type: "blur" as const, mode, at, dur, x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
  const lint = (sb: Partial<StoryboardInput>, duration = 60) => lintStoryboard(StoryboardSchema.parse({ source: "r.mp4", ...sb }), duration).filter((w) => w.startsWith("[annotation-outside]"));

  it("is quiet when the annotation lies in kept footage", () => {
    expect(lint({ segments: [{ in: 5, out: 30 }], annotations: [blur(6, 10)] })).toEqual([]);
    expect(lint({ annotations: [blur(0, 10)] })).toEqual([]);
  });

  it("is an ERROR for a solid blur completely in cut footage", () => {
    const w = lint({ segments: [{ in: 10, out: 30 }], annotations: [blur(1, 5)] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/ERROR.*annotations\[0\].*solid blur.*completely in cut footage/);
  });

  it("warns for any other annotation completely in cut footage", () => {
    const w = lint({ segments: [{ in: 10, out: 30 }], annotations: [{ type: "box", at: 1, dur: 2, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/annotations\[0\].*box.*completely in cut footage/);
    expect(w[0]).not.toMatch(/ERROR/);
  });

  it("warns when part of the range is cut (a start before segments[0].in, a cut gap) and says what is shown", () => {
    expect(lint({ segments: [{ in: 6, out: 30 }], annotations: [blur(0, 10)] })[0]).toMatch(/annotations\[0\].*partly in cut footage.*6\.0s-10\.0s/);
    const gap = lint({ segments: [{ in: 0, out: 5 }, { in: 8, out: 30 }], annotations: [blur(4, 6, "blur")] });
    expect(gap[0]).toMatch(/partly in cut footage.*4\.0s-5\.0s, 8\.0s-10\.0s/);
  });

  it("warns when the range runs past the end of the source", () => {
    expect(lint({ annotations: [blur(58, 5)] }, 60)[0]).toMatch(/partly in cut footage.*58\.0s-60\.0s/);
  });

  it("can be turned off with lint.off", () => {
    expect(lint({ segments: [{ in: 10, out: 30 }], annotations: [blur(1, 5)], lint: { off: ["annotation-outside"] } })).toEqual([]);
  });
});
