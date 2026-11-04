import { describe, expect, it } from "vitest";
import { buildCutFilter } from "../src/render/cut.js";
import { XFADE } from "../src/render/xfade.js";
import { lintStyle } from "../src/storyboard/lint.js";
import { SegmentSchema, SegmentTransitionSchema, StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const seg = (inn: number, out: number, transition?: Record<string, unknown>) => SegmentSchema.parse({ in: inn, out, ...(transition ? { transition } : {}) });
const tlOf = (segments: ReturnType<typeof seg>[], holds: { at: number; dur: number }[] = []) => buildTimeline({ segments, holds, sourceDuration: 30 });

describe("segment transitions in the schema", () => {
  it("takes a type and a length", () => {
    expect(SegmentTransitionSchema.parse({ type: "crossfade" })).toEqual({ type: "crossfade", dur: 0.5 });
    expect(SegmentTransitionSchema.parse({ type: "wipe-left", dur: 1.2 })).toEqual({ type: "wipe-left", dur: 1.2 });
    for (const type of Object.keys(XFADE)) expect(SegmentTransitionSchema.safeParse({ type }).success).toBe(true);
  });

  it("rejects an unknown type, cut (that is no transition) and a silly length", () => {
    expect(SegmentTransitionSchema.safeParse({ type: "spin" }).success).toBe(false);
    expect(SegmentTransitionSchema.safeParse({ type: "cut" }).success).toBe(false);
    expect(SegmentTransitionSchema.safeParse({ type: "crossfade", dur: 0.01 }).success).toBe(false);
    expect(SegmentTransitionSchema.safeParse({ type: "crossfade", dur: 9 }).success).toBe(false);
  });

  it("is optional on a segment", () => {
    expect(seg(0, 5).transition).toBeUndefined();
    expect(seg(0, 5, { type: "fade-black" }).transition).toEqual({ type: "fade-black", dur: 0.5 });
  });
});

describe("a transition in the timeline", () => {
  it("overlaps the segment with the one before it, so the video is shorter by the overlap", () => {
    const t = tlOf([seg(0, 5), seg(10, 15, { type: "crossfade", dur: 1 })]);
    expect(t.videoDuration).toBe(9);
    const [a, b] = t.pieces;
    expect(a).toMatchObject({ outStart: 0, outEnd: 5 });
    expect(b).toMatchObject({ outStart: 4, outEnd: 9, transition: { type: "crossfade", dur: 1 } });
  });

  it("shows each source time where its own picture is, through the overlap", () => {
    const t = tlOf([seg(0, 5), seg(10, 15, { type: "crossfade", dur: 1 })]);
    expect(t.toOutput(4.5)).toBe(4.5);
    expect(t.toOutput(10)).toBe(4);
    expect(t.toOutput(12)).toBe(6);
  });

  it("changes nothing without a transition", () => {
    const t = tlOf([seg(0, 5), seg(10, 15)]);
    expect(t.videoDuration).toBe(10);
    expect(t.pieces.every((p) => p.transition === undefined)).toBe(true);
  });

  it("is at most half of either neighbour", () => {
    const t = tlOf([seg(0, 5), seg(10, 12, { type: "crossfade", dur: 3 })]);
    expect(t.pieces[1]!.transition!.dur).toBe(1);
    const long = tlOf([seg(0, 1), seg(10, 20, { type: "crossfade", dur: 3 })]);
    expect(long.pieces[1]!.transition!.dur).toBe(0.5);
  });

  it("has nothing to blend with on the first segment", () => {
    const t = tlOf([seg(0, 5, { type: "crossfade", dur: 1 }), seg(10, 15)]);
    expect(t.videoDuration).toBe(10);
    expect(t.pieces[0]!.transition).toBeUndefined();
  });

  it("drops one too short to see", () => {
    const t = tlOf([seg(0, 0.06), seg(10, 15, { type: "crossfade", dur: 1 })]);
    expect(t.pieces[1]!.transition).toBeUndefined();
  });

  it("chains: every transition takes its overlap off the total", () => {
    const t = tlOf([seg(0, 5), seg(10, 15, { type: "crossfade", dur: 1 }), seg(20, 25, { type: "wipe-left", dur: 2 })]);
    expect(t.videoDuration).toBe(15 - 1 - 2);
    expect(t.pieces[2]).toMatchObject({ outStart: 7, outEnd: 12, transition: { type: "wipe-left", dur: 2 } });
  });

  it("blends into a hold when one starts the segment", () => {
    const t = tlOf([seg(0, 5), seg(10, 15, { type: "fade-black", dur: 1 })], [{ at: 10, dur: 2 }]);
    expect(t.pieces[1]).toMatchObject({ kind: "hold", transition: { type: "fade-black", dur: 1 } });
    expect(t.videoDuration).toBe(5 + 2 + 5 - 1);
  });

  it("keeps card spans and later times consistent", () => {
    const t = buildTimeline({
      segments: [seg(0, 5), seg(10, 15, { type: "crossfade", dur: 1 })],
      holds: [{ at: 12, dur: 2, card: 0 } as never],
      sourceDuration: 30,
      offset: 3,
    });
    expect(t.cardSpans()).toEqual([{ card: 0, start: 3 + 6, end: 3 + 8 }]);
    expect(t.toOutput(14)).toBe(3 + 8 + 2);
  });
});

describe("transitions in the cut filter", () => {
  const filter = (segments: ReturnType<typeof seg>[], keepAudio = false) => buildCutFilter({ pieces: tlOf(segments).pieces, fps: 30, sourceDuration: 30, keepAudio });

  it("is the old concat when there is no transition", () => {
    const f = filter([seg(0, 5), seg(10, 15)]);
    expect(f).toContain("concat=n=2:v=1:a=0[cv]");
    expect(f).not.toContain("xfade");
  });

  it("blends with xfade at the end of the picture so far, minus the overlap", () => {
    const f = filter([seg(0, 5), seg(10, 15, { type: "crossfade", dur: 1 })]);
    expect(f).toContain("[v0][v1]xfade=transition=fade:duration=1:offset=4[cv]");
    expect(f).not.toContain("concat");
  });

  it("uses the xfade name of each type", () => {
    for (const [type, name] of Object.entries(XFADE)) {
      expect(filter([seg(0, 5), seg(10, 15, { type, dur: 1 })])).toContain(`xfade=transition=${name}:`);
    }
    expect(XFADE["fade-black"]).toBe("fadeblack");
    expect(XFADE["fade-white"]).toBe("fadewhite");
  });

  it("blends the sound too, in one common format", () => {
    const f = filter([seg(0, 5), seg(10, 15, { type: "crossfade", dur: 1 })], true);
    expect(f).toContain("[a0][a1]acrossfade=d=1[aout]");
    expect(f).toContain("aformat=sample_rates=48000:channel_layouts=stereo");
  });

  it("mixes plain cuts and transitions, tracking the length as it goes", () => {
    const f = filter([seg(0, 5), seg(10, 15), seg(20, 25, { type: "wipe-right", dur: 2 })], true);
    expect(f).toContain("[v0][v1]concat=n=2:v=1:a=0[xv1]");
    expect(f).toContain("[a0][a1]concat=n=2:v=0:a=1[xa1]");
    // 5 + 5 = 10 s so far; the wipe starts 2 s before the end of that.
    expect(f).toContain("[xv1][v2]xfade=transition=wiperight:duration=2:offset=8[cv]");
    expect(f).toContain("[xa1][a2]acrossfade=d=2[aout]");
  });

  it("puts every piece in one timebase, because xfade refuses a mix (and the old filter has none)", () => {
    const f = filter([seg(0, 5), seg(10, 15), seg(20, 25, { type: "wipe-right", dur: 2 })]);
    expect(f.match(/,settb=AVTB\[v\d\]/g)).toHaveLength(3);
    expect(filter([seg(0, 5), seg(10, 15)])).not.toContain("settb");
  });

  it("keeps the old audio chain (no aformat) when there is no transition", () => {
    expect(filter([seg(0, 5), seg(10, 15)], true)).not.toContain("aformat");
  });
});

describe("transitions in lint", () => {
  const lint = (segments: unknown[]) => lintStyle(StoryboardSchema.parse({ source: "r.mp4", segments }));

  it("warns about a transition on the first segment and a long one", () => {
    const out = lint([
      { in: 0, out: 10, transition: { type: "crossfade" } },
      { in: 20, out: 30, transition: { type: "crossfade", dur: 2.5 } },
    ]);
    expect(out.some((m) => /segments\[0\].*transition.*first/.test(m))).toBe(true);
    expect(out.some((m) => /segments\[1\].*transition.*long/.test(m))).toBe(true);
  });

  it("is quiet for a normal one", () => {
    expect(lint([{ in: 0, out: 10 }, { in: 20, out: 30, transition: { type: "crossfade" } }])).toEqual([]);
  });
});
