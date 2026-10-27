import { describe, expect, it } from "vitest";
import {
  activeWindow,
  cocoaToQuartz,
  displayOf,
  isListable,
  matchAxWindow,
  mergeDisplays,
  type CgDisplay,
  type CgWindow,
  type NsScreen,
} from "../src/platform/macos/geometry.js";
import { parseNsScreens } from "../src/platform/macos/nsscreen.js";

// A 14" MacBook Pro (1512x982 points, 3024x1964 pixels) with a 4K monitor set
// to "looks like 1920x1080" (3840x2160 pixels, 2x) to its left, 200 pt higher.
const builtin: CgDisplay = { id: 1, bounds: { x: 0, y: 0, w: 1512, h: 982 }, pixelW: 3024, pixelH: 1964, builtin: true };
const dell: CgDisplay = { id: 724, bounds: { x: -1920, y: -200, w: 1920, h: 1080 }, pixelW: 3840, pixelH: 2160, builtin: false };

// The same in Cocoa coordinates (y up from the primary's bottom); menu bar 37 pt, Dock 70 pt at the bottom of the built-in.
const nsBuiltin: NsScreen = { id: 1, name: "Built-in Retina Display", frame: { x: 0, y: 0, w: 1512, h: 982 }, visible: { x: 0, y: 70, w: 1512, h: 875 } };
const nsDell: NsScreen = { id: 724, name: "DELL U2720Q", frame: { x: -1920, y: 102, w: 1920, h: 1080 }, visible: { x: -1920, y: 102, w: 1920, h: 1055 } };

describe("macOS display geometry", () => {
  it("converts Cocoa rects (y up) to Quartz rects (y down) against the primary's height", () => {
    expect(cocoaToQuartz({ x: 0, y: 70, w: 1512, h: 875 }, 982)).toEqual({ x: 0, y: 37, w: 1512, h: 875 });
    expect(cocoaToQuartz({ x: -1920, y: 102, w: 1920, h: 1080 }, 982)).toEqual({ x: -1920, y: -200, w: 1920, h: 1080 });
  });

  it("merges Quartz displays with NSScreen names and work areas, keeping Quartz order and point bounds", () => {
    const [a, b] = mergeDisplays([builtin, dell], [nsBuiltin, nsDell]);
    expect(a).toEqual({
      id: 1,
      screen: { name: "Built-in Retina Display", x: 0, y: 0, w: 1512, h: 982, deviceId: "1" },
      work: { x: 0, y: 37, w: 1512, h: 875 },
      pixelW: 3024,
      pixelH: 1964,
      scale: 2,
      index: 0,
    });
    expect(b!.screen).toMatchObject({ name: "DELL U2720Q", x: -1920, y: -200 });
    expect(b!.work).toEqual({ x: -1920, y: -175, w: 1920, h: 1055 });
    expect(b!.scale).toBe(2);
    expect(b!.index).toBe(1);
  });

  it("falls back to Quartz-only names and full bounds without NSScreen", () => {
    const [a, b] = mergeDisplays([builtin, dell], []);
    expect(a!.screen.name).toBe("Built-in Display");
    expect(b!.screen.name).toBe("Display 724");
    expect(b!.work).toEqual(dell.bounds);
  });

  it("makes duplicate names unique", () => {
    const twin = { ...dell, id: 725, bounds: { ...dell.bounds, x: 1512, y: 0 } };
    const ns = [nsBuiltin, nsDell, { ...nsDell, id: 725 }];
    expect(mergeDisplays([builtin, dell, twin], ns).map((d) => d.screen.name)).toEqual(["Built-in Retina Display", "DELL U2720Q", "DELL U2720Q (2)"]);
  });

  it("finds the display a window is mostly on", () => {
    const ds = mergeDisplays([builtin, dell], [nsBuiltin, nsDell]);
    expect(displayOf({ x: -300, y: 100, w: 1000, h: 500 }, ds)?.id).toBe(1);
    expect(displayOf({ x: -900, y: 100, w: 1000, h: 500 }, ds)?.id).toBe(724);
    expect(displayOf({ x: 5000, y: 0, w: 10, h: 10 }, ds)).toBeUndefined();
  });
});

const win = (o: Partial<CgWindow>): CgWindow => ({
  id: 1,
  pid: 10,
  owner: "Safari",
  name: "Apple",
  layer: 0,
  alpha: 1,
  onScreen: true,
  bounds: { x: 0, y: 37, w: 1200, h: 800 },
  ...o,
});

describe("macOS windows", () => {
  it("lists normal app windows only", () => {
    expect(isListable(win({}))).toBe(true);
    expect(isListable(win({ layer: 25 }))).toBe(false); // status item / menu bar
    expect(isListable(win({ owner: "Dock" }))).toBe(false);
    expect(isListable(win({ alpha: 0 }))).toBe(false);
    expect(isListable(win({ bounds: { x: 0, y: 0, w: 20, h: 20 } }))).toBe(false);
  });

  it("picks the focused app's front window, or the front-most window without Accessibility", () => {
    const list = [win({ id: 5, layer: 25, pid: 1 }), win({ id: 6, pid: 20, owner: "Terminal" }), win({ id: 7, pid: 10 }), win({ id: 8, pid: 10 })];
    expect(activeWindow(list, 10)?.id).toBe(7);
    expect(activeWindow(list)?.id).toBe(6);
    expect(activeWindow(list, 99)).toBeUndefined(); // e.g. Finder with only the desktop
  });

  it("matches an AX window by CG id, else by exact frame", () => {
    const bounds = { x: 10, y: 40, w: 800, h: 600 };
    expect(matchAxWindow([{ wid: 3 }, { wid: 9 }], 9, bounds)).toBe(1);
    expect(matchAxWindow([{ frame: { x: 0, y: 0, w: 5, h: 5 } }, { frame: { x: 11, y: 40, w: 800, h: 599 } }], 9, bounds)).toBe(1);
    expect(matchAxWindow([{ frame: { x: 0, y: 0, w: 5, h: 5 } }], 9, bounds)).toBe(-1);
  });
});

describe("NSScreen JXA output", () => {
  it("parses screens and drops junk", () => {
    const out = JSON.stringify([
      { id: 1, name: "Built-in Retina Display", frame: [0, 0, 1512, 982], visible: [0, 70, 1512, 875] },
      { id: "x", name: "bad", frame: [0, 0, 1, 1], visible: [0, 0, 1, 1] },
      { id: 2, name: "zero", frame: [0, 0, 0, 0], visible: [0, 0, 0, 0] },
    ]);
    expect(parseNsScreens(`${out}\n`)).toEqual([nsBuiltin]);
    expect(parseNsScreens("execution error: oops")).toEqual([]);
    expect(parseNsScreens("{}")).toEqual([]);
  });
});
