import { describe, expect, it } from "vitest";
import { buildTimeline, planNarrationHolds } from "../src/storyboard/timeline.js";

const seg = (a: number, b: number, speed = 1) => ({ in: a, out: b, speed });

describe("buildTimeline", () => {
  it("uses the whole source when no segments are given", () => {
    const tl = buildTimeline({ segments: [], holds: [], sourceDuration: 10 });
    expect(tl.videoDuration).toBe(10);
    expect(tl.toOutput(4)).toBe(4);
    expect(tl.toOutput(10)).toBe(10);
  });

  it("maps across cuts and speed changes", () => {
    const tl = buildTimeline({ segments: [seg(0, 4), seg(10, 20, 2)], holds: [], sourceDuration: 30 });
    expect(tl.videoDuration).toBe(9);
    expect(tl.toOutput(2)).toBe(2);
    expect(tl.toOutput(6)).toBeNull(); // cut out
    expect(tl.toOutput(10)).toBe(4);
    expect(tl.toOutput(14)).toBe(6);
    expect(tl.toOutput(20)).toBe(9);
  });

  it("adds the intro offset", () => {
    const tl = buildTimeline({ segments: [], holds: [], sourceDuration: 5, offset: 3 });
    expect(tl.toOutput(1)).toBe(4);
    expect(tl.videoEnd).toBe(8);
  });

  it("splits a segment at a hold and maps the hold time to the freeze start", () => {
    const tl = buildTimeline({ segments: [], holds: [{ at: 3, dur: 2 }], sourceDuration: 10 });
    expect(tl.pieces.map((p) => p.kind)).toEqual(["play", "hold", "play"]);
    expect(tl.videoDuration).toBe(12);
    expect(tl.toOutput(3)).toBe(3);
    expect(tl.toOutput(4)).toBe(6);
  });

  it("ignores holds that fall in cut regions", () => {
    const tl = buildTimeline({ segments: [seg(0, 2), seg(5, 6)], holds: [{ at: 3, dur: 1 }], sourceDuration: 6 });
    expect(tl.ignoredHolds).toEqual([{ at: 3, dur: 1 }]);
    expect(tl.videoDuration).toBe(3);
  });

  it("clamps segments to the source length", () => {
    const tl = buildTimeline({ segments: [seg(0, 99)], holds: [], sourceDuration: 7 });
    expect(tl.videoDuration).toBe(7);
  });

  it("mapSpan falls back to start+dur when the end is cut", () => {
    const tl = buildTimeline({ segments: [seg(0, 2), seg(8, 10)], holds: [], sourceDuration: 10 });
    expect(tl.mapSpan(1, 3)).toEqual({ start: 1, end: 4 });
    expect(tl.mapSpan(0, 1)).toEqual({ start: 0, end: 1 });
  });
});

describe("planNarrationHolds", () => {
  it("adds nothing when lines fit", () => {
    const holds = planNarrationHolds({
      segments: [],
      holds: [],
      sourceDuration: 20,
      gap: 0.3,
      lines: [
        { at: 0, duration: 2 },
        { at: 5, duration: 3 },
      ],
    });
    expect(holds).toEqual([]);
  });

  it("freezes the video so a long line finishes before the next one", () => {
    const input = {
      segments: [],
      holds: [],
      sourceDuration: 20,
      gap: 0.5,
      lines: [
        { at: 1, duration: 6 },
        { at: 4, duration: 2 },
      ],
    };
    const holds = planNarrationHolds(input);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.at).toBeCloseTo(3.999, 3);
    expect(holds[0]!.dur).toBeCloseTo(3.5, 5);
    const tl = buildTimeline({ ...input, holds });
    // second line now starts after first ends (1 + 6) + gap
    expect(tl.toOutput(4)).toBeCloseTo(7.5, 3);
  });

  it("chains holds when several lines overrun", () => {
    const input = {
      segments: [],
      holds: [],
      sourceDuration: 30,
      gap: 0,
      lines: [
        { at: 0, duration: 5 },
        { at: 2, duration: 5 },
        { at: 4, duration: 1 },
      ],
    };
    const holds = planNarrationHolds(input);
    const tl = buildTimeline({ ...input, holds });
    expect(tl.toOutput(2)).toBeCloseTo(5, 3);
    expect(tl.toOutput(4)).toBeCloseTo(10, 3);
  });

  it("puts the hold at the end of the previous segment when a line starts a segment", () => {
    const input = {
      segments: [seg(0, 3), seg(10, 15)],
      holds: [],
      sourceDuration: 15,
      gap: 0,
      lines: [
        { at: 0, duration: 5 },
        { at: 10, duration: 1 },
      ],
    };
    const holds = planNarrationHolds(input);
    expect(holds).toEqual([{ at: 3, dur: 2 }]);
    expect(buildTimeline({ ...input, holds }).toOutput(10)).toBe(5);
  });

  it("extends the end of the video when the last line is longer than the video", () => {
    const input = { segments: [], holds: [], sourceDuration: 4, gap: 0, tail: 0.5, lines: [{ at: 2, duration: 5 }] };
    const holds = planNarrationHolds(input);
    expect(holds).toEqual([{ at: 4, dur: 3.5 }]);
    expect(buildTimeline({ ...input, holds }).videoDuration).toBe(7.5);
  });
});
