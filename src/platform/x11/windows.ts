import type { Rect, ScreenInfo } from "../../record/input/types.js";
import type { WindowInfo } from "../types.js";
import { decodeText, frameRect, isAppWindow, monitorOf, parseExtents, parseWmClass, workAreaFor } from "./ewmh.js";
import type { XApi, XMonitor } from "./xlib.js";

// Monitors and windows of an X11 session: XRandR monitors, EWMH window list
// and properties. Takes an XApi so it runs against a fake in tests.

export interface X11Monitor {
  screen: ScreenInfo;
  /** Monitor area without panels (from _NET_WORKAREA). */
  work: Rect;
  primary: boolean;
}

/** XRandR monitors (one per active output); the whole root window when RandR reports none (e.g. bare Xvfb). */
export function monitors(x: XApi): X11Monitor[] {
  let list: XMonitor[] = x.monitors();
  if (list.length === 0) {
    const r = x.rootSize();
    list = [{ name: "screen", primary: true, x: 0, y: 0, ...r }];
  }
  const workarea = x.cardinals(x.root, "_NET_WORKAREA");
  const desktop = x.cardinals(x.root, "_NET_CURRENT_DESKTOP")?.[0] ?? 0;
  return list.map((m) => ({
    screen: { name: m.name, x: m.x, y: m.y, w: m.w, h: m.h },
    work: workAreaFor(m, workarea, desktop),
    primary: m.primary,
  }));
}

/** Window title: _NET_WM_NAME (UTF-8), else WM_NAME. */
export function windowTitle(x: XApi, win: number): string {
  const net = x.bytes(win, "_NET_WM_NAME");
  if (net) return decodeText(net.data, true);
  const legacy = x.bytes(win, "WM_NAME");
  return legacy ? decodeText(legacy.data, legacy.type === x.atom("UTF8_STRING")) : "";
}

/** The window as drawn (frame with title bar), in root coordinates. */
export function windowFrame(x: XApi, win: number): Rect | undefined {
  const client = x.clientRect(win);
  return client && frameRect(client, parseExtents(x.cardinals(win, "_NET_FRAME_EXTENTS")));
}

export function windowStates(x: XApi, win: number): string[] {
  return (x.cardinals(win, "_NET_WM_STATE") ?? []).map((a) => x.atomName(a));
}

export function activeWindow(x: XApi): number {
  return x.cardinals(x.root, "_NET_ACTIVE_WINDOW")?.[0] ?? 0;
}

/** Whether a window manager speaking EWMH is running (needed for the window list). */
export function hasEwmh(x: XApi): boolean {
  // _NET_CLIENT_LIST itself may be unset while there are no windows yet.
  return !!x.cardinals(x.root, "_NET_SUPPORTING_WM_CHECK")?.length && wmSupports(x, "_NET_CLIENT_LIST");
}

export function wmSupports(x: XApi, atom: string): boolean {
  return (x.cardinals(x.root, "_NET_SUPPORTED") ?? []).includes(x.atom(atom));
}

/** Top-level app windows in _NET_CLIENT_LIST order (oldest first). */
export function listWindows(x: XApi, mons = monitors(x)): WindowInfo[] {
  const active = activeWindow(x);
  const out: WindowInfo[] = [];
  for (const win of x.cardinals(x.root, "_NET_CLIENT_LIST") ?? []) {
    const types = (x.cardinals(win, "_NET_WM_WINDOW_TYPE") ?? []).map((a) => x.atomName(a));
    if (!isAppWindow(types)) continue;
    const frame = windowFrame(x, win);
    if (!frame) continue; // closed meanwhile
    const states = windowStates(x, win);
    out.push({
      id: String(win),
      caption: windowTitle(x, win),
      resourceClass: parseWmClass(x.bytes(win, "WM_CLASS")?.data).cls,
      pid: x.cardinals(win, "_NET_WM_PID")?.[0] ?? 0,
      active: win === active,
      minimized: states.includes("_NET_WM_STATE_HIDDEN"),
      ...frame,
      output: monitorOf(frame, mons.map((m) => m.screen))?.name ?? "",
    });
  }
  return out;
}
