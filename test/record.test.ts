import { describe, expect, it } from "vitest";
import { hasBit, parseEvents, parseMouseDevices } from "../src/record/input/evdev.js";
import { kwinScript, parseScreens } from "../src/record/input/kwin.js";
import { chooseScreen } from "../src/record/index.js";
import { normalizeEvents } from "../src/record/normalize.js";

const PROC = `I: Bus=0003 Vendor=046d Product=c52b Version=0111
N: Name="Logitech USB Receiver Mouse"
H: Handlers=event5 mouse0
B: EV=17
B: KEY=ffff0000 0 0 0 0

I: Bus=0011 Vendor=0001 Product=0001 Version=ab41
N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd event3 leds
B: EV=120013
B: KEY=402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe
`;

describe("evdev", () => {
  it("finds devices with BTN_LEFT", () => {
    expect(parseMouseDevices(PROC)).toEqual(["/dev/input/event5"]);
  });

  it("reads bits across 64-bit words", () => {
    expect(hasBit("ffff0000 0 0 0 0", 0x110)).toBe(true);
    expect(hasBit("1 0", 64)).toBe(true);
    expect(hasBit("1 0", 0)).toBe(false);
  });

  it("parses button presses and ignores autorepeat and other events", () => {
    const ev = (type: number, code: number, value: number) => {
      const b = Buffer.alloc(24);
      b.writeUInt16LE(type, 16);
      b.writeUInt16LE(code, 18);
      b.writeInt32LE(value, 20);
      return b;
    };
    const buf = Buffer.concat([ev(1, 0x110, 1), ev(0, 0, 0), ev(1, 0x111, 0), ev(1, 0x110, 2), ev(1, 30, 1)]);
    expect(parseEvents(buf)).toEqual([
      { button: 1, down: true },
      { button: 2, down: false },
    ]);
  });
});

describe("kwin", () => {
  it("parses the monitor layout the script reports", () => {
    const json = JSON.stringify([
      { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080, manufacturer: "", model: "" },
      { name: "HDMI-A-5", x: 0, y: 0, w: 1920, h: 1080, manufacturer: "Lenovo Group Limited", model: "R24e" },
    ]);
    expect(parseScreens(json)).toEqual([
      { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080 },
      { name: "HDMI-A-5", x: 0, y: 0, w: 1920, h: 1080, manufacturer: "Lenovo Group Limited", model: "R24e" },
    ]);
  });

  it("embeds the D-Bus service name safely", () => {
    expect(kwinScript("dev.screenpilot.Rec42")).toContain('var svc = "dev.screenpilot.Rec42";');
  });
});

describe("normalizeEvents", () => {
  const screen = { x: 1920, y: 0, w: 1920, h: 1080 };
  const full = { x: 0, y: 0, w: 1, h: 1 };

  it("converts to seconds since start and video-normalized coordinates", () => {
    const out = normalizeEvents(
      [
        { at: 900, type: "move", px: 2000, py: 10 }, // before start
        { at: 1500, type: "down", px: 2880, py: 540, button: 1 },
        { at: 1600, type: "move", px: 100, py: 100 }, // other monitor
      ],
      1000,
      screen,
      full,
    );
    expect(out).toEqual([{ t: 0.5, type: "down", x: 0.5, y: 0.5, button: 1 }]);
  });

  it("accounts for letterboxing inside the OBS canvas", () => {
    const out = normalizeEvents([{ at: 0, type: "move", px: 1920, py: 0 }], 0, screen, { x: 0.125, y: 0, w: 0.75, h: 1 });
    expect(out[0]).toMatchObject({ x: 0.125, y: 0 });
  });
});

describe("chooseScreen", () => {
  const screens = [
    { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080 },
    { name: "HDMI-A-5", x: 0, y: 0, w: 1920, h: 1080, model: "R24e" },
  ];

  it("prefers the monitor named in the OBS source", () => {
    expect(chooseScreen(screens, "Lenovo R24e | Monitor", { x: 2500, y: 300 }).screen?.name).toBe("HDMI-A-5");
  });

  it("falls back to the monitor under the cursor, with a warning", () => {
    const r = chooseScreen(screens, "PC Screen", { x: 2500, y: 300 });
    expect(r.screen?.name).toBe("eDP-1");
    expect(r.warning).toContain("remap");
  });

  it("honours an explicit monitor and rejects unknown names", () => {
    expect(chooseScreen(screens, "x", undefined, "eDP-1").screen?.name).toBe("eDP-1");
    expect(() => chooseScreen(screens, "x", undefined, "DP-9")).toThrow(/DP-9/);
  });
});
