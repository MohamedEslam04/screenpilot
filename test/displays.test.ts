import dbus from "dbus-next";
import { describe, expect, it } from "vitest";
import { parseHyprMonitors, parseMutterState, parseSwayOutputs, screensFromStreams } from "../src/platform/displays.js";

const V = dbus.Variant;

// A GetCurrentState body as dbus-next returns it: a laptop panel at 1.25 scale
// left of a rotated external monitor.
function mutterBody(layoutMode: number) {
  const mode = (id: string, w: number, h: number, current: boolean) => [id, w, h, 60, 1, [1, 1.25], current ? { "is-current": new V("b", true) } : {}];
  return [
    7,
    [
      [["eDP-1", "BOE", "0x0bca", "0"], [mode("a", 2560, 1600, true), mode("b", 1920, 1200, false)], { "display-name": new V("s", "Built-in display") }],
      [["DP-2", "DEL", "DELL U2720Q", "ABC"], [mode("c", 3840, 2160, true)], {}],
      [["HDMI-1", "GSM", "LG", "1"], [mode("d", 1920, 1080, false)], {}], // connected but off
    ],
    [
      [0, 0, 1.25, 0, true, [["eDP-1", "BOE", "0x0bca", "0"]], {}],
      [2048, 0, 2, 1, false, [["DP-2", "DEL", "DELL U2720Q", "ABC"]], {}],
    ],
    { "layout-mode": new V("u", layoutMode) },
  ];
}

describe("GNOME Mutter DisplayConfig", () => {
  it("gives logical monitors in logical pixels (scaled, rotated)", () => {
    expect(parseMutterState(mutterBody(1))).toEqual([
      { name: "eDP-1", x: 0, y: 0, w: 2048, h: 1280, manufacturer: "BOE", model: "Built-in display" },
      { name: "DP-2", x: 2048, y: 0, w: 1080, h: 1920, manufacturer: "DEL", model: "DELL U2720Q" },
    ]);
  });

  it("keeps mode sizes in the physical layout mode", () => {
    const [laptop, external] = parseMutterState(mutterBody(2));
    expect(laptop).toMatchObject({ w: 2560, h: 1600 });
    expect(external).toMatchObject({ w: 2160, h: 3840 });
  });
});

describe("wlroots compositors", () => {
  it("reads sway outputs (logical rects), skipping inactive ones", () => {
    const json = JSON.stringify([
      { name: "DP-1", active: true, make: "Dell", model: "U2720Q", rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
      { name: "eDP-1", active: true, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      { name: "HDMI-A-1", active: false, rect: { x: 0, y: 0, width: 0, height: 0 } },
    ]);
    expect(parseSwayOutputs(json).map((s) => `${s.name} ${s.x},${s.y} ${s.w}x${s.h}`)).toEqual(["eDP-1 0,0 1920x1080", "DP-1 1920,0 1920x1080"]);
  });

  it("reads Hyprland monitors (mode px divided by scale)", () => {
    const json = JSON.stringify([{ name: "eDP-1", x: 0, y: 0, width: 2880, height: 1800, scale: 1.5, transform: 0, make: "BOE", model: "NE160" }]);
    expect(parseHyprMonitors(json)).toEqual([{ name: "eDP-1", x: 0, y: 0, w: 1920, h: 1200, manufacturer: "BOE", model: "NE160" }]);
  });
});

describe("monitors from portal streams", () => {
  it("names positioned streams in layout order", () => {
    const s = screensFromStreams([
      { node: 51, x: 1920, y: 0, w: 1920, h: 1080 },
      { node: 50, x: 0, y: 0, w: 1920, h: 1080 },
    ]);
    expect(s).toEqual([
      { name: "screen-1", x: 0, y: 0, w: 1920, h: 1080 },
      { name: "screen-2", x: 1920, y: 0, w: 1920, h: 1080 },
    ]);
  });

  it("lays streams without positions out left to right", () => {
    const s = screensFromStreams([
      { node: 1, x: 0, y: 0, w: 1280, h: 800 },
      { node: 2, x: 0, y: 0, w: 1920, h: 1080 },
    ]);
    expect(s.map((x) => [x.x, x.w])).toEqual([
      [0, 1280],
      [1280, 1920],
    ]);
  });
});
