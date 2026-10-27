import { describe, expect, it } from "vitest";
import { canvasFor } from "../src/record/backend.js";
import { buildPipeline } from "../src/record/backends/pipewire.js";
import { chooseScreens } from "../src/record/index.js";

const screens = [
  { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080 },
  { name: "HDMI-A-5", x: 0, y: 0, w: 1920, h: 1080 },
];

describe("chooseScreens", () => {
  it("picks all, a list, a named one, or the one under the cursor", () => {
    expect(chooseScreens(screens, { screens: "all" }, undefined)).toHaveLength(2);
    expect(chooseScreens(screens, { screens: ["eDP-1"] }, undefined).map((s) => s.name)).toEqual(["eDP-1"]);
    expect(chooseScreens(screens, { screen: "HDMI-A-5" }, undefined)[0]!.name).toBe("HDMI-A-5");
    expect(chooseScreens(screens, {}, { x: 2500, y: 10 })[0]!.name).toBe("eDP-1");
    expect(() => chooseScreens(screens, { screen: "DP-9" }, undefined)).toThrow(/DP-9/);
  });
});

describe("canvasFor", () => {
  it("lays monitors out as on the desktop", () => {
    const c = canvasFor(screens, 30, "x", "y");
    expect(c.canvas).toEqual({ width: 3840, height: 1080, fps: 30 });
    expect(c.canvasScreens).toEqual([
      { name: "eDP-1", x: 0.5, y: 0, w: 0.5, h: 1 },
      { name: "HDMI-A-5", x: 0, y: 0, w: 0.5, h: 1 },
    ]);
  });
});

describe("buildPipeline", () => {
  it("records one monitor straight to Matroska", () => {
    const args = buildPipeline([{ node: 119, x: 0, y: 0, w: 1920, h: 1080 }], { w: 1920, h: 1080 }, "openh264enc", "/tmp/a.mkv");
    expect(args[0]).toBe("-e");
    expect(args).toContain("path=119");
    expect(args).not.toContain("compositor");
    expect(args.at(-1)).toBe("location=/tmp/a.mkv");
  });

  it("composes several monitors side by side", () => {
    const args = buildPipeline(
      [
        { node: 166, x: 0, y: 0, w: 1920, h: 1080 },
        { node: 119, x: 1920, y: 0, w: 1920, h: 1080 },
      ],
      { w: 3840, h: 1080 },
      "openh264enc",
      "/tmp/b.mkv",
    );
    expect(args).toContain("compositor");
    expect(args).toContain("sink_1::xpos=1920");
    expect(args).toContain("video/x-raw,width=3840,height=1080,framerate=30/1");
    expect(args.filter((a) => a.startsWith("path="))).toEqual(["path=166", "path=119"]);
  });
});
