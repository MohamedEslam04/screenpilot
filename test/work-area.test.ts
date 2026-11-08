import { describe, expect, it } from "vitest";
import { kdeWorkAreaScript, parseKdeWorkArea } from "../src/platform/kde.js";
import { intersect, sane, workAreaOf } from "../src/platform/work-area.js";

describe("KDE work area", () => {
  it("reads KWin's clientArea reply (global logical px, panel on top of eDP-1 at x=1920)", () => {
    expect(parseKdeWorkArea("[1920,50,1920,1030]")).toEqual({ x: 1920, y: 50, w: 1920, h: 1030 });
  });

  it("is undefined for an unknown monitor or an unexpected reply", () => {
    expect(parseKdeWorkArea("")).toBeUndefined();
    expect(parseKdeWorkArea("[1,2,3]")).toBeUndefined();
    expect(parseKdeWorkArea("not json")).toBeUndefined();
    expect(parseKdeWorkArea('["a",0,1,1]')).toBeUndefined();
  });

  it("asks KWin for the maximize area of the named output on the current desktop", () => {
    const js = kdeWorkAreaScript("eDP-1");
    expect(js).toContain('o.name === "eDP-1"');
    expect(js).toContain("KWin.MaximizeArea");
    expect(js).toContain("workspace.currentDesktop");
  });
});

describe("workAreaOf", () => {
  const monitors = [
    { screen: { name: "HDMI-A-5" }, work: { x: 0, y: 50, w: 1920, h: 1030 } },
    { screen: { name: "eDP-1" }, work: { x: 1920, y: 0, w: 1920, h: 1032 } },
  ];

  it("finds a monitor's work area by name, in global coordinates", () => {
    expect(workAreaOf(monitors, "eDP-1")).toEqual({ x: 1920, y: 0, w: 1920, h: 1032 });
  });

  it("is undefined for an unknown monitor", () => {
    expect(workAreaOf(monitors, "DP-9")).toBeUndefined();
  });
});

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
