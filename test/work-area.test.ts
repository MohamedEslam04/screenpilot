import { describe, expect, it } from "vitest";
import { intersect, sane } from "../src/platform/work-area.js";

describe("intersect", () => {
  it("is the overlap of two rects", () => {
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 20, w: 100, h: 100 })).toEqual({ x: 50, y: 20, w: 50, h: 80 });
  });

  it("is the inner rect when one contains the other", () => {
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 })).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });

  it("is undefined for rects that only touch", () => {
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBeUndefined();
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 100, w: 100, h: 100 })).toBeUndefined();
  });

  it("is undefined for disjoint rects", () => {
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBeUndefined();
  });
});

describe("sane", () => {
  const monitor = { x: 1920, y: 0, w: 1920, h: 1080 };

  it("accepts the monitor itself and a monitor with a 48 px bottom panel", () => {
    expect(sane(monitor, monitor)).toBe(true);
    expect(sane({ x: 1920, y: 0, w: 1920, h: 1032 }, monitor)).toBe(true);
  });

  it("accepts a panel on the left or the top (origin is not the monitor origin)", () => {
    expect(sane({ x: 1968, y: 0, w: 1872, h: 1080 }, monitor)).toBe(true);
    expect(sane({ x: 1920, y: 50, w: 1920, h: 1030 }, monitor)).toBe(true);
  });

  it("rejects an empty area", () => {
    expect(sane({ x: 1920, y: 0, w: 0, h: 1080 }, monitor)).toBe(false);
    expect(sane({ x: 1920, y: 0, w: 1920, h: -5 }, monitor)).toBe(false);
  });

  it("rejects an area larger than the monitor or outside it", () => {
    expect(sane({ x: 1920, y: 0, w: 1920, h: 1200 }, monitor)).toBe(false);
    expect(sane({ x: 0, y: 0, w: 3840, h: 1080 }, monitor)).toBe(false);
    expect(sane({ x: 0, y: 0, w: 1000, h: 500 }, monitor)).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    expect(sane({ x: 1920, y: 0, w: Number.NaN, h: 1080 }, monitor)).toBe(false);
  });
});
