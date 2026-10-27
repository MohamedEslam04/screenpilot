import { describe, expect, it } from "vitest";
import {
  activateData,
  clientSizeFor,
  frameRect,
  isAppWindow,
  monitorOf,
  moveResizeData,
  parseExtents,
  parseWmClass,
  wmStateData,
  workAreaFor,
} from "../src/platform/x11/ewmh.js";
import { wheelButton, X11Injector } from "../src/platform/x11/injector.js";
import { findKeystroke, type Keymap, keysymForChar, spareKeycodes } from "../src/platform/x11/keymap.js";
import { X11Watcher } from "../src/platform/x11/watcher.js";
import { hasEwmh, listWindows, monitors } from "../src/platform/x11/windows.js";
import { clientMessageEvent, type XApi } from "../src/platform/x11/xlib.js";
import { x11grabArgs, x11grabStillArgs } from "../src/record/backends/x11-ffmpeg.js";

// A US keymap fragment: keycode 8 + i, 2 keysyms per keycode (group 1 only),
// or 4 with a second (Arabic) group.
const A = 0x61;
function usMap(withArabic = false): Keymap {
  const per = withArabic ? 4 : 2;
  const rows: number[][] = [
    [0, 0], // 8: spare
    [0x31, 0x21], // 9: 1 !
    [A, 0x41], // 10: a A
    [0x62, 0], // 11: b (uppercase implied)
    [0xffe1, 0], // 12: Shift_L
    [0xff0d, 0], // 13: Return
    [0x20, 0], // 14: space
    [0, 0], // 15: spare
  ];
  const arabic: Record<number, [number, number]> = { 10: [0x5d4, 0x650] }; // ش on the 'a' key
  return {
    min: 8,
    per,
    syms: rows.flatMap((r, i) => (withArabic ? [...r, ...(arabic[8 + i] ?? [0, 0])] : r)),
  };
}

describe("X11 keysyms", () => {
  it("maps characters to keysyms (Latin-1 as is, the rest as Unicode keysyms)", () => {
    expect(keysymForChar("a")).toBe(0x61);
    expect(keysymForChar("é")).toBe(0xe9);
    expect(keysymForChar("\n")).toBe(0xff0d);
    expect(keysymForChar("\t")).toBe(0xff09);
    expect(keysymForChar("م")).toBe(0x01000645);
    expect(keysymForChar("😀")).toBe(0x0101f600);
  });

  it("finds the key and Shift level for a keysym", () => {
    const map = usMap();
    expect(findKeystroke(map, A)).toEqual({ code: 10, shift: false });
    expect(findKeystroke(map, 0x41)).toEqual({ code: 10, shift: true });
    expect(findKeystroke(map, 0x21)).toEqual({ code: 9, shift: true });
    expect(findKeystroke(map, 0x42)).toEqual({ code: 11, shift: true }); // lone 'b' also types 'B'
    expect(findKeystroke(map, 0x01000645)).toBeUndefined();
  });

  it("uses the active layout's columns, falling back to group 1 for keys it leaves empty", () => {
    const map = usMap(true);
    expect(findKeystroke(map, A, 0)).toEqual({ code: 10, shift: false });
    expect(findKeystroke(map, A, 1)).toBeUndefined(); // the 'a' key types ش in the Arabic layout
    expect(findKeystroke(map, 0x5d4, 1)).toEqual({ code: 10, shift: false });
    expect(findKeystroke(map, 0x31, 1)).toEqual({ code: 9, shift: false }); // no Arabic symbols there: group 1
    expect(findKeystroke(map, A, 2)).toBeUndefined();
  });

  it("lists keycodes without symbols as spares, highest first", () => {
    expect(spareKeycodes(usMap())).toEqual([15, 8]);
    expect(spareKeycodes(usMap(), 1)).toEqual([15]);
  });
});

/** A fake X server: a root with EWMH properties, two monitors, two windows. */
function fakeX(over: Partial<XApi> = {}): XApi & { sent: unknown[][]; keys: [number, boolean][]; remaps: [number, number[]][] } {
  const atoms = new Map<string, number>();
  const atom = (n: string) => {
    if (!atoms.has(n)) atoms.set(n, 100 + atoms.size);
    return atoms.get(n)!;
  };
  const name = (a: number) => [...atoms].find(([, v]) => v === a)?.[0] ?? "";
  const ROOT = 1;
  const props: Record<number, Record<string, number[] | string>> = {
    [ROOT]: {
      _NET_SUPPORTING_WM_CHECK: [9],
      _NET_SUPPORTED: [atom("_NET_CLIENT_LIST"), atom("_NET_MOVERESIZE_WINDOW")],
      _NET_CLIENT_LIST: [0x400001, 0x400002, 0x400003],
      _NET_ACTIVE_WINDOW: [0x400002],
      _NET_WORKAREA: [0, 30, 3840, 1050],
      _NET_CURRENT_DESKTOP: [0],
    },
    0x400001: { WM_CLASS: "xterm\0XTerm\0", _NET_WM_NAME: "bash — ~", _NET_WM_PID: [42], _NET_FRAME_EXTENTS: [1, 1, 24, 1] },
    0x400002: { WM_CLASS: "smoke\0SmokeTarget\0", WM_NAME: "café", _NET_WM_STATE: [atom("_NET_WM_STATE_HIDDEN")] },
    0x400003: { WM_CLASS: "panel\0Panel\0", _NET_WM_WINDOW_TYPE: [atom("_NET_WM_WINDOW_TYPE_DOCK")] },
  };
  const rects: Record<number, { x: number; y: number; w: number; h: number }> = {
    0x400001: { x: 2000, y: 100, w: 800, h: 600 },
    0x400002: { x: 10, y: 60, w: 400, h: 300 },
    0x400003: { x: 0, y: 0, w: 3840, h: 30 },
  };
  const sent: unknown[][] = [];
  const keys: [number, boolean][] = [];
  const remaps: [number, number[]][] = [];
  const map = usMap();
  return {
    root: ROOT,
    atom,
    atomName: name,
    cardinals: (w, p) => {
      const v = props[w]?.[p];
      return Array.isArray(v) ? v : undefined;
    },
    bytes: (w, p) => {
      const v = props[w]?.[p];
      return typeof v === "string" ? { type: atom(p === "_NET_WM_NAME" ? "UTF8_STRING" : "STRING"), data: Buffer.from(v, p === "_NET_WM_NAME" ? "utf8" : "latin1") } : undefined;
    },
    monitors: () => [
      { name: "eDP-1", primary: true, x: 0, y: 0, w: 1920, h: 1080 },
      { name: "HDMI-1", primary: false, x: 1920, y: 0, w: 1920, h: 1080 },
    ],
    rootSize: () => ({ w: 3840, h: 1080 }),
    pointer: () => ({ x: 5, y: 7 }),
    clientRect: (w) => rects[w],
    clientMessage: (...a) => void sent.push(a),
    moveResize: (...a) => void sent.push(["XMoveResizeWindow", ...a]),
    raiseAndFocus: () => {},
    hasXTest: () => true,
    fakeMotion: (...a) => void sent.push(["motion", ...a]),
    fakeButton: (...a) => void sent.push(["button", ...a]),
    fakeKey: (code, down) => void keys.push([code, down]),
    keymap: () => ({ ...map, syms: [...map.syms] }),
    setKeysyms: (code, syms) => void remaps.push([code, syms]),
    group: () => 0,
    flush: () => {},
    sync: () => {},
    sent,
    keys,
    remaps,
    ...over,
  };
}

describe("X11 monitors and windows (EWMH)", () => {
  it("lists XRandR monitors with their work area (_NET_WORKAREA minus panels)", () => {
    const m = monitors(fakeX());
    expect(m.map((x) => x.screen.name)).toEqual(["eDP-1", "HDMI-1"]);
    expect(m[0]!.work).toEqual({ x: 0, y: 30, w: 1920, h: 1050 });
    expect(m[1]!.primary).toBe(false);
  });

  it("falls back to the root window when RandR reports no monitor", () => {
    expect(monitors(fakeX({ monitors: () => [] })).map((m) => m.screen)).toEqual([{ name: "screen", x: 0, y: 0, w: 3840, h: 1080 }]);
  });

  it("lists app windows with frame, class, title, pid, state and monitor", () => {
    const wins = listWindows(fakeX());
    expect(wins).toHaveLength(2); // the dock is not an app window
    expect(wins[0]).toEqual({
      id: String(0x400001),
      caption: "bash — ~",
      resourceClass: "XTerm",
      pid: 42,
      active: false,
      minimized: false,
      x: 1999,
      y: 76,
      w: 802,
      h: 625,
      output: "HDMI-1",
    });
    expect(wins[1]).toMatchObject({ caption: "café", resourceClass: "SmokeTarget", pid: 0, active: true, minimized: true, output: "eDP-1" });
  });

  it("knows whether an EWMH window manager runs", () => {
    expect(hasEwmh(fakeX())).toBe(true);
    expect(hasEwmh(fakeX({ cardinals: () => undefined }))).toBe(false);
  });

  it("decodes ICCCM / EWMH properties", () => {
    expect(parseWmClass(Buffer.from("navigator\0firefox\0"))).toEqual({ instance: "navigator", cls: "firefox" });
    expect(parseWmClass(undefined)).toEqual({ instance: "", cls: "" });
    expect(isAppWindow([])).toBe(true);
    expect(isAppWindow(["_NET_WM_WINDOW_TYPE_DIALOG"])).toBe(true);
    expect(isAppWindow(["_NET_WM_WINDOW_TYPE_DESKTOP"])).toBe(false);
    expect(workAreaFor({ x: 1920, y: 0, w: 1920, h: 1080 }, [0, 0, 1920, 1080, 0, 30, 3840, 1050], 1)).toEqual({ x: 1920, y: 30, w: 1920, h: 1050 });
    expect(workAreaFor({ x: 0, y: 0, w: 100, h: 100 }, undefined)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(monitorOf({ x: 1800, y: 0, w: 400, h: 100 }, [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }])?.x).toBe(1920);
  });

  it("builds move/resize, state and activate requests", () => {
    const e = parseExtents([2, 2, 30, 2]);
    expect(frameRect({ x: 100, y: 100, w: 800, h: 600 }, e)).toEqual({ x: 98, y: 70, w: 804, h: 632 });
    expect(clientSizeFor({ x: 0, y: 0, w: 804, h: 632 }, e)).toEqual({ w: 800, h: 600 });
    // NorthWest gravity, x/y/w/h present, from a pager; frame position + client size.
    expect(moveResizeData({ x: 98, y: 70, w: 804, h: 632 }, e)).toEqual([0x2f01, 98, 70, 800, 600]);
    expect(wmStateData(false, 300, 301)).toEqual([0, 300, 301, 2, 0]);
    expect(activateData(77)).toEqual([2, 0, 77, 0, 0]);
  });

  it("lays out a ClientMessage XEvent as Xlib does on 64-bit", () => {
    const ev = clientMessageEvent(0x400001, 321, [1, 2, 3, -1, 5]);
    expect(ev.length).toBe(192);
    expect(ev.readInt32LE(0)).toBe(33);
    expect(ev.readBigUInt64LE(32)).toBe(0x400001n);
    expect(ev.readBigUInt64LE(40)).toBe(321n);
    expect(ev.readInt32LE(48)).toBe(32);
    expect([0, 1, 2, 3, 4].map((i) => Number(ev.readBigInt64LE(56 + i * 8)))).toEqual([1, 2, 3, -1, 5]);
  });
});

describe("X11 injector (XTest)", () => {
  const screens = [{ name: "eDP-1", x: 0, y: 0, w: 1920, h: 1080 }];
  const hooks = { before: () => {}, gap: () => 0 };

  it("moves only onto monitors and maps wheel steps to buttons 4-7", async () => {
    const x = fakeX();
    const inj = new X11Injector(x, screens);
    expect(await inj.moveTo(100, 200)).toBe(true);
    expect(await inj.moveTo(2500, 200)).toBe(false);
    expect(x.sent).toEqual([["motion", 100, 200]]);
    expect([wheelButton(false, 1), wheelButton(false, -1), wheelButton(true, -1), wheelButton(true, 1)]).toEqual([5, 4, 6, 7]);
  });

  it("types mapped keys directly, with Shift where needed", async () => {
    const x = fakeX();
    await new X11Injector(x, screens).typeText("aA!\n", hooks);
    expect(x.keys).toEqual([
      [10, true], [10, false],
      [12, true], [10, true], [10, false], [12, false],
      [12, true], [9, true], [9, false], [12, false],
      [13, true], [13, false],
    ]);
    expect(x.remaps).toEqual([]);
  });

  it("binds characters no key has to spare keycodes (round robin) and unbinds them on close", async () => {
    const x = fakeX();
    const inj = new X11Injector(x, screens);
    await inj.typeText("مرم", hooks);
    expect(x.remaps).toEqual([
      [15, [0x01000645, 0x01000645]],
      [8, [0x01000631, 0x01000631]],
    ]);
    expect(x.keys.filter(([, down]) => down).map(([c]) => c)).toEqual([15, 8, 15]); // the second م reuses its binding
    await inj.close();
    expect(x.remaps.slice(2)).toEqual([
      [15, [0, 0]],
      [8, [0, 0]],
    ]);
  });

  it("presses combos in order and releases in reverse", async () => {
    const x = fakeX();
    await new X11Injector(x, screens).pressCombo("shift+a");
    expect(x.keys).toEqual([
      [12, true],
      [10, true],
      [10, false],
      [12, false],
    ]);
  });
});

describe("X11 watcher", () => {
  it("logs pointer moves and the active window (clipped to the work area)", async () => {
    let p = { x: 10, y: 20 };
    const x = fakeX({ pointer: () => p });
    const w = new X11Watcher(async () => x, false);
    await w.start();
    p = { x: 30, y: 40 };
    await new Promise((r) => setTimeout(r, 60));
    await w.stop();
    expect(w.screens().map((s) => s.name)).toEqual(["eDP-1", "HDMI-1"]);
    expect(w.events.map((e) => [e.type, e.px, e.py])).toEqual([
      ["move", 10, 20],
      ["move", 30, 40],
    ]);
    expect(w.cursor()).toEqual({ x: 30, y: 40 });
    // Active window 0x400002: client 10,60 400x300, no extents; work area starts at y=30.
    expect(w.focus).toHaveLength(1);
    expect(w.focus[0]).toMatchObject({ id: String(0x400002), cls: "SmokeTarget", title: "café", x: 10, y: 60, w: 400, h: 300 });
  });
});

describe("x11grab arguments", () => {
  const left = { name: "eDP-1", x: 0, y: 0, w: 1920, h: 1080 };
  const right = { name: "HDMI-1", x: 1920, y: 0, w: 2560, h: 1440 };
  const opt = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it("grabs one monitor at its position on the display", () => {
    const args = x11grabArgs([right], [left, right], "out.mkv", ":0");
    expect(opt(args, "-f")).toBe("x11grab");
    expect(opt(args, "-framerate")).toBe("30");
    expect(opt(args, "-video_size")).toBe("2560x1440");
    expect(opt(args, "-i")).toBe(":0+1920,0");
    expect(opt(args, "-c:v")).toBe("libx264");
    expect(args.at(-1)).toBe("out.mkv");
  });

  it("grabs the bounding box of several monitors", () => {
    const args = x11grabArgs([left, right], [left, right], "out.mkv", ":1");
    expect(opt(args, "-video_size")).toBe("4480x1440");
    expect(opt(args, "-i")).toBe(":1+0,0");
  });

  it("crops odd sizes to even and refuses areas off the screen", () => {
    const odd = { name: "x", x: 0, y: 0, w: 1365, h: 767 };
    expect(opt(x11grabArgs([odd], [odd], "o.mkv", ":0"), "-vf")).toBe("crop=1364:766:0:0");
    expect(() => x11grabArgs([{ ...right, x: 3000 }], [left, right], "o.mkv", ":0")).toThrow(/outside/);
  });

  it("takes a single still of a monitor", () => {
    const args = x11grabStillArgs(right, "s.jpg", 960, ":0");
    expect(opt(args, "-i")).toBe(":0+1920,0");
    expect(opt(args, "-frames:v")).toBe("1");
    expect(opt(args, "-vf")).toBe("scale=960:-2");
  });
});
