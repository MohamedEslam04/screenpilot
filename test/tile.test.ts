import { describe, expect, it } from "vitest";
import type { Desktop } from "../src/platform/types.js";
import { tiledView, tileRects, tileTarget } from "../src/take/tile.js";

const eDP = { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080 };

function fake(workArea?: Desktop["workArea"]): Pick<Desktop, "workArea"> {
  return { workArea };
}

describe("tileTarget (work area of the monitor, else the monitor)", () => {
  it("uses the work area: a 48 px bottom panel makes both tiles 48 px shorter, starting at its top", async () => {
    const warns: string[] = [];
    const area = await tileTarget(fake(async () => ({ x: 1920, y: 0, w: 1920, h: 1032 })), eDP, (m) => warns.push(m));
    expect(tileRects(area, 2)).toEqual([
      { x: 1920, y: 0, w: 960, h: 1032 },
      { x: 2880, y: 0, w: 960, h: 1032 },
    ]);
    expect(warns).toEqual([]);
  });

  it("a panel on the left or top moves the origin; tiles stay left to right inside the area", async () => {
    const left = await tileTarget(fake(async () => ({ x: 1968, y: 0, w: 1872, h: 1080 })), eDP, () => {});
    const [a, b] = tileRects(left, 2);
    expect(a!.x).toBe(1968);
    expect(b!.x).toBe(1968 + 936);
    expect(b!.x + b!.w).toBe(1920 + 1920);

    const top = await tileTarget(fake(async () => ({ x: 1920, y: 50, w: 1920, h: 1030 })), eDP, () => {});
    for (const r of tileRects(top, 2)) expect(r).toMatchObject({ y: 50, h: 1030 });
  });

  it("asks for the monitor it tiles on, by name", async () => {
    const asked: string[] = [];
    await tileTarget(
      fake(async (s) => {
        asked.push(s);
        return undefined;
      }),
      eDP,
      () => {},
    );
    expect(asked).toEqual(["eDP-1"]);
  });

  it("falls back to the whole monitor (as in 0.9.0) when the desktop has no workArea or cannot tell", async () => {
    const monitor = { x: 1920, y: 0, w: 1920, h: 1080 };
    expect(await tileTarget(fake(undefined), eDP, () => {})).toEqual(monitor);
    expect(await tileTarget(fake(async () => undefined), eDP, () => {})).toEqual(monitor);
    expect(tileRects(await tileTarget(fake(undefined), eDP, () => {}), 2)).toEqual(tileRects(monitor, 2));
  });

  it("ignores an empty or oversized work area with a warning", async () => {
    const monitor = { x: 1920, y: 0, w: 1920, h: 1080 };
    for (const bad of [{ x: 1920, y: 0, w: 0, h: 0 }, { x: 1920, y: 0, w: 1920, h: 2000 }, { x: 0, y: 0, w: 3840, h: 1080 }]) {
      const warns: string[] = [];
      expect(await tileTarget(fake(async () => bad), eDP, (m) => warns.push(m))).toEqual(monitor);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("eDP-1");
    }
  });

  it("falls back with a warning when workArea throws", async () => {
    const warns: string[] = [];
    const area = await tileTarget(
      fake(async () => {
        throw new Error("KWin script did not answer");
      }),
      eDP,
      (m) => warns.push(m),
    );
    expect(area).toEqual({ x: 1920, y: 0, w: 1920, h: 1080 });
    expect(warns[0]).toContain("KWin script did not answer");
  });
});

describe("tiledView of a work area", () => {
  it("is the tiled rect, not the monitor (50 px panel on top of a monitor recorded alone)", () => {
    const v = tiledView({ x: 1920, y: 50, w: 1920, h: 1030 }, { x: 1920, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1, h: 1 }, ["main", "user"]);
    expect(v.rect.x).toBe(0);
    expect(v.rect.w).toBe(1);
    expect(v.rect.y).toBeCloseTo(50 / 1080);
    expect(v.rect.h).toBeCloseTo(1030 / 1080);
  });
});
