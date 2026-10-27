import { describe, expect, it } from "vitest";
import { mapStreams } from "../src/drive/index.js";
import { charKeysym, parseCombo, splitTyping } from "../src/drive/keys.js";
import { parseStreams } from "../src/drive/portal.js";
import { mapSources } from "../src/drive/see.js";
import { contentToScreen } from "../src/drive/web.js";

const screens = [
  { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080, model: "32429" },
  { name: "HDMI-A-5", x: 0, y: 0, w: 1920, h: 1080, model: "R24e" },
];

describe("keys", () => {
  it("maps printable Latin-1 and control characters", () => {
    expect(charKeysym("a")).toBe(0x61);
    expect(charKeysym("A")).toBe(0x41);
    expect(charKeysym("\n")).toBe(0xff0d);
    expect(charKeysym("م")).toBeNull();
  });

  it("parses combos", () => {
    expect(parseCombo("ctrl+shift+T")).toEqual([0xffe3, 0xffe1, 0x74]);
    expect(parseCombo("F5")).toEqual([0xffc2]);
    expect(() => parseCombo("ctrl+nope")).toThrow(/nope/);
  });

  it("splits text into key runs and clipboard runs", () => {
    expect(splitTyping("Hi مرحبا!")).toEqual([
      { keys: true, text: "Hi " },
      { keys: false, text: "مرحبا" },
      { keys: true, text: "!" },
    ]);
  });
});

describe("portal streams", () => {
  it("parses Start's streams", () => {
    const raw = [[144, { position: [1920, 0], size: [1920, 1080], source_type: 1 }]];
    expect(parseStreams(raw)).toEqual([{ node: 144, x: 1920, y: 0, w: 1920, h: 1080 }]);
  });

  it("maps streams to monitors by position", () => {
    const m = mapStreams(
      [
        { node: 144, x: 1920, y: 0, w: 1920, h: 1080 },
        { node: 119, x: 0, y: 0, w: 1920, h: 1080 },
      ],
      screens,
    );
    expect(m.get("eDP-1")?.node).toBe(144);
    expect(m.get("HDMI-A-5")?.node).toBe(119);
  });
});

describe("mapSources", () => {
  it("uses names, then elimination", () => {
    const m = mapSources(["Lenovo R24e | Monitor", "PC Screen"], screens);
    expect(m.get("HDMI-A-5")).toBe("Lenovo R24e | Monitor");
    expect(m.get("eDP-1")).toBe("PC Screen");
  });

  it("prefers a saved mapping", () => {
    const m = mapSources(["A", "B"], screens, { A: "eDP-1", B: "HDMI-A-5" });
    expect(m.get("eDP-1")).toBe("A");
    expect(m.get("HDMI-A-5")).toBe("B");
  });
});

describe("contentToScreen", () => {
  it("adds the window position and toolbar height", () => {
    const p = contentToScreen(
      { x: 100, y: 50, width: 20, height: 10 },
      { iw: 1000, ih: 700, ow: 1000, oh: 800 },
      { x: 500, y: 60, w: 1000, h: 800 },
    );
    // toolbar = 100px, so content starts at y=160
    expect(p).toEqual({ x: 610, y: 215, w: 20, h: 10 });
  });

  it("scales CSS px to logical px", () => {
    const p = contentToScreen(
      { x: 0, y: 0, width: 10, height: 10 },
      { iw: 2000, ih: 1400, ow: 2000, oh: 1600 },
      { x: 0, y: 0, w: 1000, h: 800 },
    );
    expect(p.w).toBe(5);
    expect(p.y).toBe(100 + 2.5);
  });
});
