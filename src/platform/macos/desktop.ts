import type { Rect } from "../../record/input/types.js";
import { findWindow, type Desktop, type Placement, type WindowInfo } from "../types.js";
import { placeInArea } from "../windows/geometry.js";
import { clipRect, displayOf, isListable, matchAxWindow, mergeDisplays, type Display } from "./geometry.js";
import { MacInjector } from "./injector.js";
import { nsScreens } from "./nsscreen.js";
import { permissionError } from "./permissions.js";
import { quartz, type AxWindow, type Quartz } from "./quartz.js";
import { MacWatcher } from "./watcher.js";

// macOS 12+ (Apple Silicon and Intel) through Quartz and the Accessibility
// API (koffi). Window ids are CGWindowIDs as decimal strings. All geometry
// is in global points; see geometry.ts for how that meets Retina pixels.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Displays with names, work areas and pixel sizes, in Quartz's (and avfoundation's) order. */
export async function displays(): Promise<Display[]> {
  const cg = (await quartz()).displays();
  const key = cg.map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.w},${d.bounds.h}`).join(";");
  return mergeDisplays(cg, await nsScreens(key));
}

/**
 * Throw the "allow Screen Recording" steps unless allowed. The first time it
 * also asks macOS to prompt, which adds the app to the list in System Settings.
 */
export async function ensureScreenCapture(): Promise<void> {
  const q = await quartz();
  if (q.screenCaptureAllowed()) return;
  q.requestScreenCapture();
  throw await permissionError("screen");
}

async function listWindows(): Promise<WindowInfo[]> {
  const q = await quartz();
  const ds = await displays();
  const wins = q.windows().filter(isListable);
  const focused = q.axTrusted() ? q.focusedPid() : undefined;
  const active = focused !== undefined ? wins.find((w) => w.pid === focused) : wins[0];
  return wins.map((w) => {
    const d = displayOf(w.bounds, ds);
    const r = (d && clipRect(w.bounds, d.work)) ?? w.bounds;
    return {
      id: String(w.id),
      // Window titles need Screen Recording permission; the app name stands in without it.
      caption: w.name || w.owner,
      resourceClass: w.owner,
      pid: w.pid,
      active: w === active,
      // Minimized windows and windows on other Spaces are not on screen, so they are not listed.
      minimized: false,
      ...r,
      output: d?.screen.name ?? "",
    };
  });
}

async function needAccessibility(q: Quartz): Promise<void> {
  if (!q.axTrusted()) throw await permissionError("accessibility");
}

/** The AX handle of CG window `id`; the other handles are released. */
async function axWindowOf(q: Quartz, id: string): Promise<{ win: AxWindow; pid: number }> {
  const wid = Number(id);
  const cg = /^\d+$/.test(id) ? q.windows().find((w) => w.id === wid) : undefined;
  if (!cg) throw new Error(`No window with id ${id} on screen`);
  await needAccessibility(q);
  const cands = q.appWindows(cg.pid);
  const i = matchAxWindow(cands, wid, cg.bounds);
  for (const [j, c] of cands.entries()) if (j !== i) c.win.release();
  if (i < 0) throw new Error(`Window ${id} (${cg.owner}) cannot be controlled through Accessibility`);
  return { win: cands[i]!.win, pid: cg.pid };
}

async function focusWindow(id: string, place?: Placement): Promise<void> {
  const q = await quartz();
  const { win, pid } = await axWindowOf(q, id);
  try {
    if (win.bool("AXMinimized")) win.setBool("AXMinimized", false);
    if (place) {
      let target: Rect | undefined;
      if ("screen" in place) {
        const d = (await displays()).find((x) => x.screen.name === place.screen);
        if (d) target = placeInArea(d.work, place.margin, place.aspect); // unknown monitor: ignored, as on KDE
      } else {
        target = { x: Math.round(place.x), y: Math.round(place.y), w: Math.round(place.w), h: Math.round(place.h) };
      }
      if (target) {
        // A full-screen window lives in its own Space and cannot be moved: leave full screen first (animated).
        if (win.bool("AXFullScreen")) {
          win.setBool("AXFullScreen", false);
          await sleep(1000);
        }
        win.setFrame(target);
      }
    }
    q.activate(pid, win);
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      if (q.focusedPid() === pid) return;
    }
    throw new Error(`macOS did not bring window ${id} to the front`);
  } finally {
    win.release();
  }
}

async function fitWindow(match: string, aspect = 16 / 9): Promise<{ window: WindowInfo; restore: () => Promise<void> }> {
  const win = findWindow(await listWindows(), match);
  if (!win) throw new Error(`No window matching "${match}" to fit`);
  const q = await quartz();
  const ax = await axWindowOf(q, win.id);
  const saved = ax.win.frame();
  ax.win.release();
  await focusWindow(win.id, { screen: win.output, aspect });
  return {
    window: win,
    restore: async () => {
      if (!saved) return;
      try {
        const again = await axWindowOf(q, win.id);
        again.win.setFrame(saved);
        again.win.release();
      } catch {
        // the window was closed meanwhile
      }
    },
  };
}

export const macosDesktop: Desktop = {
  id: "macos",
  windowControl: true,

  async screens() {
    return (await displays()).map((d) => d.screen);
  },

  listWindows,
  focusWindow,
  fitWindow,

  // Notification banners and Focus modes have no public API: nothing is closed or held.
  // (Turn on Do Not Disturb from Control Center before recording.)
  closeNotificationPopups: async () => 0,
  quietNotifications: async () => async () => {},
  // Text is typed as Unicode key events and shortcuts use key codes, so the input source never matters.
  useLatinLayout: async () => async () => {},

  async openInjector(screens) {
    const q = await quartz();
    // Without Accessibility macOS drops synthetic events silently: fail loudly instead.
    await needAccessibility(q);
    return new MacInjector(q, screens);
  },

  createWatcher() {
    return new MacWatcher(quartz, displays);
  },
};
