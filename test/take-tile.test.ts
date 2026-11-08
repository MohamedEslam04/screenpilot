import { describe, expect, it } from "vitest";
import { boundingRect, tiledView, tileRects } from "../src/take/tile.js";

describe("tileRects", () => {
  it("splits a monitor at global x=1920 into two equal columns, left to right", () => {
    expect(tileRects({ x: 1920, y: 0, w: 1920, h: 1080 }, 2)).toEqual([
      { x: 1920, y: 0, w: 960, h: 1080 },
      { x: 2880, y: 0, w: 960, h: 1080 },
    ]);
  });

  it("covers the area exactly when the width does not divide evenly", () => {
    const rs = tileRects({ x: 0, y: 30, w: 1366, h: 738 }, 3);
    expect(rs).toHaveLength(3);
    expect(rs[0]!.x).toBe(0);
    for (let i = 1; i < rs.length; i++) expect(rs[i]!.x).toBe(rs[i - 1]!.x + rs[i - 1]!.w);
    expect(rs.at(-1)!.x + rs.at(-1)!.w).toBe(1366);
    for (const r of rs) expect(r).toMatchObject({ y: 30, h: 738 });
  });

  it("gives one window the whole area", () => {
    expect(tileRects({ x: 10, y: 20, w: 300, h: 200 }, 1)).toEqual([{ x: 10, y: 20, w: 300, h: 200 }]);
  });
});

describe("boundingRect", () => {
  it("is the smallest rect around every window", () => {
    expect(
      boundingRect([
        { x: 1920, y: 0, w: 960, h: 1040 },
        { x: 2880, y: 10, w: 960, h: 1070 },
      ]),
    ).toEqual({ x: 1920, y: 0, w: 1920, h: 1080 });
  });
});

describe("tiledView", () => {
  it("does not offset the tiled area by the monitor origin (monitor at x=1920 of a two-monitor recording)", () => {
    const v = tiledView({ x: 1920, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 3840, h: 1080 }, { x: 0, y: 0, w: 1, h: 1 }, ["main", "user"]);
    expect(v).toEqual({ at: 0, rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, label: "browsers: main, user", transition: "cut" });
  });

  it("fills the frame when only that monitor was recorded", () => {
    const v = tiledView({ x: 1920, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1, h: 1 }, ["main", "user"]);
    expect(v.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
