import type { Rect, ScreenInfo } from "../../record/input/types.js";

// Display and window geometry for macOS, kept free of koffi so it can be
// unit tested anywhere.
//
// Units: every global coordinate is in POINTS, Quartz style (origin at the
// top-left of the main display, y down). CGEvent, CGWindowList, the AX API
// and browser CSS pixels all use points, so injection, window placement and
// web targets need no conversion. A Retina display has 2 pixels per point:
// only the recorder and screenshots deal with pixels (Display.pixelW/H), and
// pointer/window logs are normalized against the point rect, so they line up
// with the pixel video whatever its scale.

/** One active display as Quartz reports it. */
export interface CgDisplay {
  id: number;
  /** CGDisplayBounds: global points. */
  bounds: Rect;
  /** Backing pixels of the current mode (2x bounds on Retina). */
  pixelW: number;
  pixelH: number;
  builtin: boolean;
}

/** What AppKit's NSScreen adds (read through JXA): a name and the area without menu bar and Dock. */
export interface NsScreen {
  id: number;
  name: string;
  /** Cocoa coordinates: origin at the bottom-left of the primary screen, y up. */
  frame: Rect;
  visible: Rect;
}

export interface Display {
  id: number;
  screen: ScreenInfo;
  /** Usable area (no menu bar, no Dock), global points. */
  work: Rect;
  pixelW: number;
  pixelH: number;
  /** Pixels per point. */
  scale: number;
  /** Position in CGGetActiveDisplayList (= ffmpeg avfoundation "Capture screen N"). */
  index: number;
}

/** Cocoa rect (y up from the primary screen's bottom) → Quartz rect (y down from its top). */
export function cocoaToQuartz(r: Rect, primaryHeight: number): Rect {
  return { x: r.x, y: primaryHeight - (r.y + r.h), w: r.w, h: r.h };
}

/**
 * Displays with names and work areas. Names come from NSScreen
 * (e.g. "Built-in Retina Display", "DELL U2720Q"), made unique; without
 * NSScreen they fall back to "Built-in Display" / "Display <id>", and the work
 * area to the full bounds.
 */
export function mergeDisplays(cg: CgDisplay[], ns: NsScreen[]): Display[] {
  // NSScreen.screens[0] is the primary (menu bar) screen: Cocoa's y axis starts at its bottom.
  const primaryH = ns[0]?.frame.h ?? cg.find((d) => d.bounds.x === 0 && d.bounds.y === 0)?.bounds.h ?? 0;
  const seen = new Map<string, number>();
  return cg.map((d, index) => {
    const n = ns.find((s) => s.id === d.id);
    let name = n?.name.trim() || (d.builtin ? "Built-in Display" : `Display ${d.id}`);
    const dup = seen.get(name) ?? 0;
    seen.set(name, dup + 1);
    if (dup) name = `${name} (${dup + 1})`;
    const work = n && primaryH ? cocoaToQuartz(n.visible, primaryH) : d.bounds;
    return {
      id: d.id,
      screen: { name, ...d.bounds, deviceId: String(d.id) },
      work: clipRect(work, d.bounds) ?? d.bounds,
      pixelW: d.pixelW,
      pixelH: d.pixelH,
      scale: d.bounds.w ? d.pixelW / d.bounds.w : 1,
      index,
    };
  });
}

export function clipRect(r: Rect, area: Rect): Rect | undefined {
  const x0 = Math.max(r.x, area.x);
  const y0 = Math.max(r.y, area.y);
  const x1 = Math.min(r.x + r.w, area.x + area.w);
  const y1 = Math.min(r.y + r.h, area.y + area.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

const overlap = (a: Rect, b: Rect) => {
  const c = clipRect(a, b);
  return c ? c.w * c.h : 0;
};

/** The display a window is mostly on. */
export function displayOf<T extends { screen: Rect }>(r: Rect, displays: T[]): T | undefined {
  let best: T | undefined;
  let area = 0;
  for (const d of displays) {
    const a = overlap(r, d.screen);
    if (a > area) {
      area = a;
      best = d;
    }
  }
  return best;
}

/** One entry of CGWindowListCopyWindowInfo. */
export interface CgWindow {
  id: number;
  pid: number;
  owner: string;
  /** Needs Screen Recording permission (macOS 10.15+); "" without it. */
  name: string;
  layer: number;
  alpha: number;
  onScreen: boolean;
  bounds: Rect;
}

// Always-on-screen system surfaces that are layer-0 windows too.
const SYSTEM_OWNERS = new Set(["Window Server", "Dock", "SystemUIServer", "Control Center", "Notification Center", "WindowManager", "Spotlight"]);

/** Roughly what Mission Control shows: normal (layer 0), visible, app windows of a usable size. */
export function isListable(w: CgWindow): boolean {
  if (w.layer !== 0 || w.alpha <= 0 || !w.onScreen) return false;
  if (SYSTEM_OWNERS.has(w.owner)) return false;
  return w.bounds.w >= 40 && w.bounds.h >= 40;
}

/**
 * The AX window that is CG window `id`: by the window id when the AX API
 * gives it (`ids`), else the one at exactly the same place and size.
 */
export function matchAxWindow(cands: { wid?: number; frame?: Rect }[], id: number, bounds: Rect): number {
  const byId = cands.findIndex((c) => c.wid === id);
  if (byId >= 0) return byId;
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  return cands.findIndex((c) => !!c.frame && near(c.frame.x, bounds.x) && near(c.frame.y, bounds.y) && near(c.frame.w, bounds.w) && near(c.frame.h, bounds.h));
}

/**
 * The window being used: the front-most listable window of the app with
 * keyboard focus (none when that app shows no window, e.g. the desktop);
 * without Accessibility (`focusedPid` unknown) the front-most listable window.
 * `windows` is front to back.
 */
export function activeWindow(windows: CgWindow[], focusedPid?: number): CgWindow | undefined {
  const listable = windows.filter(isListable);
  return focusedPid !== undefined ? listable.find((w) => w.pid === focusedPid) : listable[0];
}
