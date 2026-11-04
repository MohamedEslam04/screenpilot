import { describe, expect, it } from "vitest";
import { buildCutFilter } from "../src/render/cut.js";
import { GradeSchema, StoryboardSchema } from "../src/storyboard/schema.js";

const pieces = [{ kind: "play" as const, in: 0, out: 5, speed: 1, volume: 1, outStart: 0, outEnd: 5 }];
const base = { pieces, fps: 30, sourceDuration: 10, keepAudio: false };

describe("theme.grade in the schema", () => {
  it("is off by default and fills the neutral values", () => {
    expect(StoryboardSchema.parse({ source: "r.mp4" }).theme.grade).toBeUndefined();
    expect(GradeSchema.parse({})).toEqual({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 });
    expect(GradeSchema.parse({ contrast: 1.2 })).toMatchObject({ contrast: 1.2, saturation: 1 });
  });

  it("keeps each value in the range ffmpeg's eq filter takes", () => {
    expect(GradeSchema.safeParse({ brightness: 2 }).success).toBe(false);
    expect(GradeSchema.safeParse({ contrast: -1 }).success).toBe(false);
    expect(GradeSchema.safeParse({ saturation: 4 }).success).toBe(false);
    expect(GradeSchema.safeParse({ gamma: 0 }).success).toBe(false);
    expect(StoryboardSchema.safeParse({ source: "r.mp4", theme: { grade: { saturation: 1.3 } } }).success).toBe(true);
  });
});

describe("grading in the cut filter", () => {
  it("adds one eq with only the values that differ from neutral, before the final scale", () => {
    const f = buildCutFilter({ ...base, grade: { brightness: 0, contrast: 1.1, saturation: 1.25, gamma: 1 } });
    expect(f).toContain("eq=contrast=1.1:saturation=1.25");
    expect(f).not.toContain("brightness");
    expect(f).not.toContain("gamma");
    expect(f.indexOf("eq=")).toBeGreaterThan(f.indexOf("concat="));
    expect(f.indexOf("eq=")).toBeLessThan(f.indexOf("scale="));
  });

  it("adds nothing for a neutral grade or none, so the old filter stays byte-identical", () => {
    const plain = buildCutFilter(base);
    expect(plain).not.toContain("eq=");
    expect(buildCutFilter({ ...base, grade: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 } })).toBe(plain);
  });

  it("takes brightness and gamma", () => {
    const f = buildCutFilter({ ...base, grade: { brightness: -0.05, contrast: 1, saturation: 1, gamma: 0.9 } });
    expect(f).toContain("eq=brightness=-0.05:gamma=0.9");
  });
});
