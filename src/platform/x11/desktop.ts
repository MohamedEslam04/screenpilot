import type { Rect } from "../../record/input/types.js";
import { quietNotifications } from "../../record/quiet.js";
import { findWindow, type Desktop, type Placement, type WindowInfo } from "../types.js";
import { placeInArea } from "../windows/geometry.js";
import { activateData, moveResizeData, parseExtents, wmStateData } from "./ewmh.js";
import { X11Injector } from "./injector.js";
import { X11Watcher } from "./watcher.js";
import { activeWindow, hasEwmh, listWindows, monitors, windowFrame, windowStates, wmSupports } from "./windows.js";
import { x11, type XApi } from "./xlib.js";

// Any X11 session (GNOME on Xorg, Cinnamon, MATE, Xfce, KDE X11, ...):
// monitors from XRandR, input through XTest, windows through EWMH requests
// to the window manager. Window ids are X window ids as decimal strings.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_VERT = "_NET_WM_STATE_MAXIMIZED_VERT";
const MAX_HORZ = "_NET_WM_STATE_MAXIMIZED_HORZ";

function windowId(id: string): number {
  if (!/^\d+$/.test(id)) throw new Error(`No window with id ${id}`);
  return Number(id);
}

async function api(): Promise<XApi> {
  return x11();
}

/** Wait (briefly) until `check` holds: the window manager applies requests asynchronously. */
async function settle(check: () => boolean, ms = 1000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(30);
  }
}

/** Move/resize so the frame (title bar included) is `target`. */
async function setFrame(x: XApi, win: number, target: Rect): Promise<void> {
  const extents = parseExtents(x.cardinals(win, "_NET_FRAME_EXTENTS"));
  const data = moveResizeData(target, extents);
  if (wmSupports(x, "_NET_MOVERESIZE_WINDOW")) {
    x.clientMessage(win, "_NET_MOVERESIZE_WINDOW", data);
  } else {
    // ICCCM: with the default NorthWest gravity x/y is where the frame goes.
    x.moveResize(win, data[1]!, data[2]!, data[3]!, data[4]!);
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  await settle(() => {
    const f = windowFrame(x, win);
    return !!f && near(f.x, target.x) && near(f.y, target.y) && near(f.w, target.w) && near(f.h, target.h);
  });
}

async function setMaximized(x: XApi, win: number, vert: boolean, horz: boolean, on: boolean): Promise<void> {
  if (!vert && !horz) return;
  x.clientMessage(win, "_NET_WM_STATE", wmStateData(on, x.atom(vert ? MAX_VERT : MAX_HORZ), vert && horz ? x.atom(MAX_HORZ) : 0));
  await settle(() => {
    const s = windowStates(x, win);
    return (!vert || s.includes(MAX_VERT) === on) && (!horz || s.includes(MAX_HORZ) === on);
  });
}

async function activate(x: XApi, win: number): Promise<void> {
  if (hasEwmh(x)) {
    x.clientMessage(win, "_NET_ACTIVE_WINDOW", activateData(activeWindow(x)));
    if (await settle(() => activeWindow(x) === win)) return;
  }
  x.raiseAndFocus(win); // no EWMH window manager, or it ignored the request
}

async function focusWindow(id: string, place?: Placement): Promise<void> {
  const x = await api();
  const win = windowId(id);
  if (!windowFrame(x, win)) throw new Error(`No window with id ${id}`);
  if (place) {
    let target: Rect | undefined;
    if ("screen" in place) {
      const mon = monitors(x).find((m) => m.screen.name === place.screen);
      if (mon) target = placeInArea(mon.work, place.margin, place.aspect); // unknown monitor: ignored, as on KDE
    } else {
      target = { x: Math.round(place.x), y: Math.round(place.y), w: Math.round(place.w), h: Math.round(place.h) };
    }
    if (target) {
      // A maximized window keeps its maximized size; un-maximize first.
      const s = windowStates(x, win);
      await setMaximized(x, win, s.includes(MAX_VERT), s.includes(MAX_HORZ), false);
      await setFrame(x, win, target);
    }
  }
  await activate(x, win);
}

async function fitWindow(match: string, aspect = 16 / 9): Promise<{ window: WindowInfo; restore: () => Promise<void> }> {
  const x = await api();
  const win = findWindow(listWindows(x), match);
  if (!win) throw new Error(`No window matching "${match}" to fit`);
  const id = windowId(win.id);
  const states = windowStates(x, id);
  const vert = states.includes(MAX_VERT);
  const horz = states.includes(MAX_HORZ);
  // The normal (un-maximized) frame is what the window returns to; read it after un-maximizing.
  await setMaximized(x, id, vert, horz, false);
  const normal = windowFrame(x, id);
  await focusWindow(win.id, { screen: win.output, aspect });
  return {
    window: win,
    restore: async () => {
      if (!windowFrame(x, id)) return; // closed meanwhile
      if (normal) await setFrame(x, id, normal);
      await setMaximized(x, id, vert, horz, true);
    },
  };
}

export const x11Desktop: Desktop = {
  id: "x11",
  windowControl: true,

  async screens() {
    return monitors(await api()).map((m) => m.screen);
  },

  async listWindows() {
    const x = await api();
    if (!hasEwmh(x)) throw new Error("No EWMH window manager is running on this X display, so windows can't be listed.");
    return listWindows(x);
  },

  focusWindow,
  fitWindow,

  // X11 notification daemons draw their own popups; there is no common way to close them.
  closeNotificationPopups: async () => 0,
  // freedesktop Notifications.Inhibit where the daemon supports it.
  quietNotifications,
  // Typing binds missing characters to a spare keycode, so the layout never matters.
  useLatinLayout: async () => async () => {},

  async openInjector(screens) {
    const x = await api();
    if (!x.hasXTest()) throw new Error("The X server has no XTEST extension, which is needed to drive the desktop.");
    return new X11Injector(x, screens);
  },

  createWatcher() {
    return new X11Watcher();
  },
};
