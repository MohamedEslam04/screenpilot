import { describe, expect, it } from "vitest";
import {
  borderInsets,
  clipRect,
  isListable,
  outerRect,
  placeInArea,
  rectFromLTRB,
  toScreen,
  WS_EX_APPWINDOW,
  WS_EX_TOOLWINDOW,
} from "../src/platform/windows/geometry.js";

describe("invisible border correction", () => {
  // Windows 10/11: GetWindowRect includes ~7px invisible resize borders left, right and bottom.
  const windowRect = { x: 100, y: 50, w: 1016, h: 607 };
  const frame = { x: 107, y: 50, w: 1002, h: 600 };

  it("measures the invisible border on each side", () => {
    expect(borderInsets(windowRect, frame)).toEqual({ left: 7, top: 0, right: 7, bottom: 7 });
  });

  it("grows the wanted visible rect by the border so the visible frame lands exactly", () => {
    const ins = borderInsets(windowRect, frame);
    expect(outerRect({ x: 0, y: 0, w: 1280, h: 720 }, ins)).toEqual({ x: -7, y: 0, w: 1294, h: 727 });
  });

  it("is a no-op for borderless windows", () => {
    const ins = borderInsets(frame, frame);
    expect(outerRect({ x: 10, y: 20, w: 300, h: 200 }, ins)).toEqual({ x: 10, y: 20, w: 300, h: 200 });
  });

  it("converts Win32 RECTs", () => {
    expect(rectFromLTRB({ left: -1920, top: 0, right: 0, bottom: 1080 })).toEqual({ x: -1920, y: 0, w: 1920, h: 1080 });
  });
});

describe("placement in a work area", () => {
  it("centers a 16:9 window inset by 2% of the shorter side (same math as KDE)", () => {
    // 1920x1080 monitor with a 40px taskbar at the bottom.
    expect(placeInArea({ x: 0, y: 0, w: 1920, h: 1040 })).toEqual({ x: 73, y: 21, w: 1774, h: 998 });
  });

  it("honours margin and aspect, on a monitor left of the primary", () => {
    expect(placeInArea({ x: -1920, y: 0, w: 1920, h: 1080 }, 0, 4 / 3)).toEqual({ x: -1680, y: 0, w: 1440, h: 1080 });
  });
});

describe("clipping to the work area", () => {
  const work = { x: 0, y: 0, w: 1920, h: 1040 };

  it("cuts off the part under the taskbar", () => {
    expect(clipRect({ x: 100, y: 900, w: 800, h: 400 }, work)).toEqual({ x: 100, y: 900, w: 800, h: 140 });
  });

  it("returns undefined when nothing is left", () => {
    expect(clipRect({ x: 0, y: 1040, w: 1920, h: 40 }, work)).toBeUndefined();
  });
});

describe("window filtering", () => {
  const app = { title: "Inbox - Outlook", className: "rctrl_renwnd32", visible: true, cloaked: false, exStyle: 0 };

  it("keeps normal app windows", () => {
    expect(isListable(app)).toBe(true);
  });

  it("drops hidden, cloaked and untitled windows", () => {
    expect(isListable({ ...app, visible: false })).toBe(false);
    expect(isListable({ ...app, cloaked: true })).toBe(false); // e.g. UWP apps on another virtual desktop
    expect(isListable({ ...app, title: "  " })).toBe(false);
  });

  it("drops tool windows unless they force a taskbar button", () => {
    expect(isListable({ ...app, exStyle: WS_EX_TOOLWINDOW })).toBe(false);
    expect(isListable({ ...app, exStyle: WS_EX_TOOLWINDOW | WS_EX_APPWINDOW })).toBe(true);
  });

  it("drops the desktop and taskbars", () => {
    expect(isListable({ ...app, title: "Program Manager", className: "Progman" })).toBe(false);
    expect(isListable({ ...app, className: "Shell_TrayWnd" })).toBe(false);
    expect(isListable({ ...app, className: "Shell_SecondaryTrayWnd" })).toBe(false);
  });
});

describe("monitors", () => {
  const id = "\\\\?\\DISPLAY#DELA1B2#5&2c03a3e2&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";

  it("names a monitor by its GDI device and keeps model and device id", () => {
    expect(toScreen("\\\\.\\DISPLAY1", { x: 0, y: 0, w: 3840, h: 2160 }, "DELL U2720Q", id)).toEqual({
      name: "\\\\.\\DISPLAY1",
      x: 0,
      y: 0,
      w: 3840,
      h: 2160,
      model: "DELL U2720Q",
      deviceId: id,
    });
  });

  it("drops the generic driver name as a model", () => {
    const s = toScreen("\\\\.\\DISPLAY2", { x: -1920, y: 0, w: 1920, h: 1080 }, "Generic PnP Monitor", undefined);
    expect(s).toEqual({ name: "\\\\.\\DISPLAY2", x: -1920, y: 0, w: 1920, h: 1080 });
  });
});
