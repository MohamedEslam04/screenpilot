import { describe, expect, it } from "vitest";
import { buildCutFilter } from "../src/render/cut.js";
import { clipStoryboard } from "../src/storyboard/clip.js";
import { lintStyle } from "../src/storyboard/lint.js";
import { SegmentSchema, StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline, type PlayPiece } from "../src/storyboard/timeline.js";

const seg = (extra: Record<string, unknown>) => SegmentSchema.parse({ in: 0, out: 12, ...extra });
const plays = (t: ReturnType<typeof buildTimeline>) => t.pieces.filter((p): p is PlayPiece => p.kind === "play");

describe("speedTo in the schema", () => {
  it("is optional and bounded like speed", () => {
    expect(seg({}).speedTo).toBeUndefined();
    expect(seg({ speed: 1, speedTo: 8 }).speedTo).toBe(8);
    expect(SegmentSchema.safeParse({ in: 0, out: 5, speedTo: 0.1 }).success).toBe(false);
    expect(SegmentSchema.safeParse({ in: 0, out: 5, speedTo: 20 }).success).toBe(false);
  });
});

describe("a speed ramp in the timeline", () => {
  it("changes nothing without speedTo or when it equals the speed", () => {
    const flat = buildTimeline({ segments: [seg({ speed: 2 })], holds: [], sourceDuration: 20 });
    expect(plays(flat)).toHaveLength(1);
    const same = buildTimeline({ segments: [seg({ speed: 2, speedTo: 2 })], holds: [], sourceDuration: 20 });
    expect(plays(same)).toHaveLength(1);
  });

  it("splits the segment into steps that cover it exactly, one after the other", () => {
    const t = buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [], sourceDuration: 20 });
    const p = plays(t);
    expect(p.length).toBeGreaterThan(2);
    expect(p.length).toBeLessThanOrEqual(12);
    expect(p[0]!.in).toBe(0);
    expect(p.at(-1)!.out).toBeCloseTo(12, 6);
    p.slice(1).forEach((x, i) => {
      expect(x.in).toBeCloseTo(p[i]!.out, 6);
      expect(x.outStart).toBeCloseTo(p[i]!.outEnd, 6);
    });
  });

  it("speeds up smoothly from speed to speedTo (geometric, so it feels even)", () => {
    const p = plays(buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [], sourceDuration: 20 }));
    const speeds = p.map((x) => x.speed);
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b));
    expect(speeds[0]!).toBeGreaterThan(1);
    expect(speeds[0]!).toBeLessThan(1.3);
    expect(speeds.at(-1)!).toBeLessThan(4);
    expect(speeds.at(-1)!).toBeGreaterThan(3.2);
    const ratios = speeds.slice(1).map((s, i) => s / speeds[i]!);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1e-9);
  });

  it("slows down when speedTo is lower", () => {
    const speeds = plays(buildTimeline({ segments: [seg({ speed: 4, speedTo: 1 })], holds: [], sourceDuration: 20 })).map((x) => x.speed);
    expect(speeds).toEqual([...speeds].sort((a, b) => b - a));
  });

  it("takes less output time than the slow end and more than the fast end alone", () => {
    const out = (s: Record<string, unknown>) => buildTimeline({ segments: [seg(s)], holds: [], sourceDuration: 20 }).videoDuration;
    expect(out({ speed: 1, speedTo: 4 })).toBeLessThan(out({ speed: 1 }));
    expect(out({ speed: 1, speedTo: 4 })).toBeGreaterThan(out({ speed: 4 }));
  });

  it("keeps a short segment to a couple of steps", () => {
    const p = plays(buildTimeline({ segments: [seg({ in: 0, out: 1, speed: 1, speedTo: 8 })], holds: [], sourceDuration: 20 }));
    expect(p).toHaveLength(2);
  });

  it("keeps the same ramp across a hold inside the segment", () => {
    const plain = plays(buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [], sourceDuration: 20 }));
    const held = buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [{ at: 6, dur: 2 }], sourceDuration: 20 });
    const speedAt = (pieces: PlayPiece[], t: number) => pieces.find((x) => t >= x.in && t < x.out)!.speed;
    for (const t of [0.5, 3.2, 5.9, 6.1, 9.4, 11.5]) expect(speedAt(plays(held), t)).toBeCloseTo(speedAt(plain, t), 9);
    expect(held.videoDuration).toBeCloseTo(buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [], sourceDuration: 20 }).videoDuration + 2, 6);
  });

  it("maps source times through the steps", () => {
    const t = buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [], sourceDuration: 20 });
    const a = t.toOutput(3)!;
    const b = t.toOutput(9)!;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // Later source seconds go by faster, so the same 3 s of source take less output.
    expect(t.toOutput(12 - 1e-3)! - t.toOutput(9)!).toBeLessThan(t.toOutput(3)! - t.toOutput(0)!);
  });

  it("feeds the cut filter one trim per step", () => {
    const t = buildTimeline({ segments: [seg({ speed: 1, speedTo: 4 })], holds: [], sourceDuration: 20 });
    const f = buildCutFilter({ pieces: t.pieces, fps: 30, sourceDuration: 20, keepAudio: false });
    expect(f.match(/trim=start=/g)).toHaveLength(plays(t).length);
  });
});

describe("a ramp in a clipped storyboard", () => {
  const sb = StoryboardSchema.parse({ source: "r.mp4", segments: [{ in: 0, out: 40, speed: 1, speedTo: 8 }] });

  it("keeps the speed curve where the clip cuts it", () => {
    const a = clipStoryboard(sb, { to: 20 }, 40).segments[0]!;
    const b = clipStoryboard(sb, { from: 20 }, 40).segments[0]!;
    // 1 -> 8 over 40 s: halfway it is 8^0.5 = 2.83x.
    expect(a.speed).toBe(1);
    expect(a.speedTo).toBeCloseTo(Math.sqrt(8), 3);
    expect(b.speed).toBeCloseTo(Math.sqrt(8), 3);
    expect(b.speedTo).toBe(8);
  });

  it("leaves a constant-speed segment alone", () => {
    const flat = StoryboardSchema.parse({ source: "r.mp4", segments: [{ in: 0, out: 40, speed: 2 }] });
    expect(clipStoryboard(flat, { to: 20 }, 40).segments[0]).toEqual({ in: 0, out: 20, speed: 2 });
  });
});

describe("a ramp in lint", () => {
  const lint = (segments: unknown[]) => lintStyle(StoryboardSchema.parse({ source: "r.mp4", segments }));

  it("warns when either end is over the speed limit", () => {
    expect(lint([{ in: 0, out: 20, speed: 1, speedTo: 12 }]).some((m) => /segments\[0\].*12x/.test(m))).toBe(true);
    expect(lint([{ in: 0, out: 20, speed: 1, speedTo: 6 }])).toEqual([]);
  });

  it("warns about a ramp on a segment too short to see it", () => {
    expect(lint([{ in: 0, out: 0.8, speed: 1, speedTo: 4 }]).some((m) => /segments\[0\].*ramp.*short/.test(m))).toBe(true);
  });
});
