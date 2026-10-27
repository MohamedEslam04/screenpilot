import { describe, expect, it } from "vitest";
import { camFor, planCamera } from "../src/render/zoom.js";

describe("camFor", () => {
  it("centers the focus point", () => {
    expect(camFor(0.5, 0.5, 2, 1728, 972)).toEqual({ x: -864, y: -486, scale: 2 });
  });

  it("clamps so the frame never shows past its edges", () => {
    expect(camFor(0, 0, 2, 1000, 500)).toEqual({ x: 0, y: 0, scale: 2 });
    expect(camFor(1, 1, 2, 1000, 500)).toEqual({ x: -1000, y: -500, scale: 2 });
  });
});

describe("planCamera", () => {
  it("zooms in before the span and out after it", () => {
    const tweens = planCamera([{ start: 2, end: 5, x: 0.5, y: 0.5, scale: 2 }], 1000, 500);
    expect(tweens).toEqual([
      { t: 1.4, dur: 0.6, x: -500, y: -250, scale: 2 },
      { t: 5, dur: 0.6, x: 0, y: 0, scale: 1 },
    ]);
  });

  it("pans directly between close zooms", () => {
    const tweens = planCamera(
      [
        { start: 2, end: 4, x: 0.25, y: 0.5, scale: 2 },
        { start: 5, end: 7, x: 0.75, y: 0.5, scale: 2 },
      ],
      1000,
      500,
    );
    expect(tweens.map((t) => [t.t, t.scale])).toEqual([
      [1.4, 2],
      [4.4, 2],
      [7, 1],
    ]);
  });

  it("never starts a tween before the previous one finished", () => {
    const tweens = planCamera(
      [
        { start: 0.2, end: 0.5, x: 0.5, y: 0.5, scale: 2 },
        { start: 0.6, end: 3, x: 0.1, y: 0.1, scale: 1.5 },
      ],
      1000,
      500,
    );
    for (let i = 1; i < tweens.length; i++) {
      expect(tweens[i]!.t).toBeGreaterThanOrEqual(tweens[i - 1]!.t + tweens[i - 1]!.dur - 1e-9);
    }
  });
});
