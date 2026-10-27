import type { Rect } from "../../record/input/types.js";

// EWMH / ICCCM property decoding and the message payloads we send to the
// window manager. Pure, so it is unit tested without an X server.

/** WM_CLASS is "instance\0class\0" (STRING). */
export function parseWmClass(bytes: Uint8Array | undefined): { instance: string; cls: string } {
  if (!bytes?.length) return { instance: "", cls: "" };
  const [instance = "", cls = ""] = Buffer.from(bytes).toString("latin1").split("\0");
  return { instance, cls };
}

/** A text property: UTF8_STRING as UTF-8, STRING as Latin-1 (trailing NULs dropped). */
export function decodeText(bytes: Uint8Array, utf8: boolean): string {
  return Buffer.from(bytes).toString(utf8 ? "utf8" : "latin1").replace(/\0+$/, "");
}

/** _NET_FRAME_EXTENTS is left, right, top, bottom. */
export interface Extents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function parseExtents(values: number[] | undefined): Extents {
  const [left = 0, right = 0, top = 0, bottom = 0] = values ?? [];
  return { left, right, top, bottom };
}

/** The window as seen on screen (with title bar and borders) from its client area. */
export function frameRect(client: Rect, e: Extents): Rect {
  return { x: client.x - e.left, y: client.y - e.top, w: client.w + e.left + e.right, h: client.h + e.top + e.bottom };
}

/** The client size that gives a `frame`-sized window. */
export function clientSizeFor(frame: Rect, e: Extents): { w: number; h: number } {
  return { w: Math.max(1, frame.w - e.left - e.right), h: Math.max(1, frame.h - e.top - e.bottom) };
}

/**
 * _NET_WORKAREA holds x, y, w, h per virtual desktop, over the whole screen
 * (all monitors). A monitor's usable area is its overlap with the current
 * desktop's entry; the monitor itself when there is none.
 */
export function workAreaFor(monitor: Rect, workarea: number[] | undefined, desktop = 0): Rect {
  const i = desktop * 4;
  if (!workarea || workarea.length < i + 4) return monitor;
  const [x, y, w, h] = workarea.slice(i, i + 4) as [number, number, number, number];
  const x0 = Math.max(monitor.x, x);
  const y0 = Math.max(monitor.y, y);
  const x1 = Math.min(monitor.x + monitor.w, x + w);
  const y1 = Math.min(monitor.y + monitor.h, y + h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : monitor;
}

const NORTH_WEST_GRAVITY = 1;
const SOURCE_PAGER = 2;

/**
 * _NET_MOVERESIZE_WINDOW data: with NorthWest gravity x/y place the frame's
 * top-left corner; width/height are the client size (EWMH).
 */
export function moveResizeData(frame: Rect, e: Extents): number[] {
  const flags = NORTH_WEST_GRAVITY | (0xf << 8) | (SOURCE_PAGER << 12); // x, y, width and height present
  const size = clientSizeFor(frame, e);
  return [flags, Math.round(frame.x), Math.round(frame.y), Math.round(size.w), Math.round(size.h)];
}

/** _NET_WM_STATE client message data: action 0 = remove, 1 = add. */
export function wmStateData(add: boolean, a: number, b = 0): number[] {
  return [add ? 1 : 0, a, b, SOURCE_PAGER, 0];
}

/** _NET_ACTIVE_WINDOW client message data (as a pager, so focus stealing prevention lets it through). */
export function activateData(currentActive: number): number[] {
  return [SOURCE_PAGER, 0, currentActive, 0, 0];
}

/** Window types that are not app windows (panels, desktop, menus, popups...). */
export const SKIP_TYPES = [
  "_NET_WM_WINDOW_TYPE_DESKTOP",
  "_NET_WM_WINDOW_TYPE_DOCK",
  "_NET_WM_WINDOW_TYPE_TOOLBAR",
  "_NET_WM_WINDOW_TYPE_MENU",
  "_NET_WM_WINDOW_TYPE_SPLASH",
  "_NET_WM_WINDOW_TYPE_NOTIFICATION",
  "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
  "_NET_WM_WINDOW_TYPE_POPUP_MENU",
  "_NET_WM_WINDOW_TYPE_TOOLTIP",
  "_NET_WM_WINDOW_TYPE_COMBO",
  "_NET_WM_WINDOW_TYPE_DND",
];

/** A window is listed unless one of its types is a non-app type (no type = normal). */
export function isAppWindow(typeNames: string[]): boolean {
  return !typeNames.some((t) => SKIP_TYPES.includes(t));
}

/** The monitor holding most of `r` (first when it is on none). */
export function monitorOf<T extends Rect>(r: Rect, monitors: T[]): T | undefined {
  let best: T | undefined;
  let bestArea = 0;
  for (const m of monitors) {
    const w = Math.min(r.x + r.w, m.x + m.w) - Math.max(r.x, m.x);
    const h = Math.min(r.y + r.h, m.y + m.h) - Math.max(r.y, m.y);
    const area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) {
      best = m;
      bestArea = area;
    }
  }
  return best ?? monitors[0];
}
