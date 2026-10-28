import { describe, expect, it } from "vitest";
import { clipStoryboard } from "../src/storyboard/clip.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";

const sb = StoryboardSchema.parse({
  source: "rec.mp4",
  segments: [
    { in: 0, out: 10 },
    { in: 20, out: 50, speed: 2 },
    { in: 55, out: 60 },
  ],
  holds: [
    { at: 5, dur: 1 },
    { at: 42, dur: 1 },
    { at: 60, dur: 2 },
  ],
  zooms: [
    { at: 30, dur: 3, x: 0.5, y: 0.5 },
    { at: 40, dur: 4, x: 0.2, y: 0.2 },
    { at: 41.8, dur: 0.5, x: 0.3, y: 0.3 },
  ],
  captions: [
    { at: 1, text: "early" },
    { at: 41, dur: 3, text: "straddles" },
    { at: 45, text: "late" },
  ],
  highlights: [{ at: 41.7, dur: 0.6, x: 0, y: 0, w: 0.1, h: 0.1 }],
  narration: [
    { at: 2, text: "first" },
    { at: 41, text: "cut mid-line" },
    { at: 42, text: "right at the cut" },
  ],
  screens: [
    { name: "A", x: 0, y: 0, w: 0.5, h: 1 },
    { name: "B", x: 0.5, y: 0, w: 0.5, h: 1 },
  ],
  views: [
    { at: 0, screen: "A" },
    { at: 35, screen: "B", transition: "cut" },
    { at: 48, screen: "A" },
  ],
});

describe("clipStoryboard", () => {
  it("keeps the source range before the cut, closing spans at the cut", () => {
    const c = clipStoryboard(sb, { to: 42 }, 60);
    expect(c.segments).toEqual([
      { in: 0, out: 10, speed: 1 },
      { in: 20, out: 42, speed: 2 },
    ]);
    // A hold exactly at the cut belongs to the part after it.
    expect(c.holds).toEqual([{ at: 5, dur: 1 }]);
    expect(c.zooms.map((z) => [z.at, z.dur])).toEqual([
      [30, 3],
      [40, 2],
    ]);
    expect(c.captions.map((x) => [x.text, x.at, x.dur])).toEqual([
      ["early", 1, 3],
      ["straddles", 41, 1],
    ]);
    // Less than 0.5 s of it would be left: dropped.
    expect(c.highlights).toEqual([]);
    expect(c.narration.map((n) => n.text)).toEqual(["first", "cut mid-line"]);
    expect(c.views.map((v) => [v.at, v.screen])).toEqual([
      [0, "A"],
      [35, "B"],
    ]);
    expect(c.screens).toHaveLength(2);
  });

  it("keeps the source range after the cut, carrying in what was on screen", () => {
    const c = clipStoryboard(sb, { from: 42 }, 60);
    expect(c.segments).toEqual([
      { in: 42, out: 50, speed: 2 },
      { in: 55, out: 60, speed: 1 },
    ]);
    // The last hold sits on the very end of the video and stays.
    expect(c.holds).toEqual([
      { at: 42, dur: 1 },
      { at: 60, dur: 2 },
    ]);
    // Started before the cut and still running: re-timed to start at it.
    expect(c.zooms.map((z) => [z.at, z.dur])).toEqual([[42, 2]]);
    expect(c.captions.map((x) => [x.text, x.at, x.dur])).toEqual([
      ["straddles", 42, 2],
      ["late", 45, 3],
    ]);
    expect(c.highlights).toEqual([]);
    // A line that started before the cut cannot be resumed mid-word: dropped.
    expect(c.narration.map((n) => n.text)).toEqual(["right at the cut"]);
    // The camera starts where it was at the cut.
    expect(c.views.map((v) => [v.at, v.screen])).toEqual([
      [42, "B"],
      [48, "A"],
    ]);
  });

  it("clips a middle range and treats empty segments as the whole video", () => {
    const whole = StoryboardSchema.parse({ source: "rec.mp4", captions: [{ at: 4, text: "x" }] });
    const c = clipStoryboard(whole, { from: 3, to: 6 }, 8);
    expect(c.segments).toEqual([{ in: 3, out: 6, speed: 1 }]);
    expect(c.captions.map((x) => [x.at, x.dur])).toEqual([[4, 2]]);
  });

  it("does not touch the input", () => {
    const before = JSON.stringify(sb);
    clipStoryboard(sb, { from: 42 }, 60);
    expect(JSON.stringify(sb)).toBe(before);
  });

  it("refuses a range that keeps nothing", () => {
    expect(() => clipStoryboard(sb, { from: 12, to: 18 }, 60)).toThrow(/keeps nothing/);
    expect(() => clipStoryboard(sb, { from: 30, to: 20 }, 60)).toThrow(/from/);
  });
});
