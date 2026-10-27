import type { Rect } from "../../record/input/types.js";
import { findWindow, type Desktop, type Placement, type WindowInfo } from "../types.js";
import { borderInsets, isListable, outerRect, placeInArea } from "./geometry.js";
import { WindowsInjector } from "./injector.js";
import { keyInput, VK_MENU } from "./inputs.js";
import { sourceMonitor } from "./obsmap.js";
import { windowArea, WindowsWatcher } from "./watcher.js";
import { SW_RESTORE, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, win32, type Win32 } from "./win32.js";

// Windows 10/11 through Win32 (koffi). Window ids are HWNDs as decimal strings.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hwnd = (id: string) => {
  if (!/^\d+$/.test(id)) throw new Error(`No window with id ${id}`);
  return BigInt(id);
};

async function listWindows(): Promise<WindowInfo[]> {
  const w = await win32();
  const monitors = w.monitors();
  const fg = w.foreground();
  const out: WindowInfo[] = [];
  for (const h of w.topWindows()) {
    const facts = {
      title: w.title(h),
      className: w.className(h),
      visible: !!w.fn.IsWindowVisible(h),
      cloaked: w.cloaked(h),
      exStyle: w.exStyle(h),
    };
    if (!isListable(facts)) continue;
    const minimized = !!w.fn.IsIconic(h);
    const { frame, monitor, visible } = windowArea(w, h, monitors);
    // Minimized windows sit far off-screen; report their raw rect (flagged `minimized`).
    const r = (minimized ? frame : visible) ?? frame ?? { x: 0, y: 0, w: 0, h: 0 };
    const { pid } = w.owner(h);
    out.push({
      id: String(h),
      caption: facts.title,
      resourceClass: w.exeName(pid),
      pid,
      active: h === fg,
      minimized,
      ...r,
      output: monitor?.screen.name ?? "",
    });
  }
  return out;
}

/** Move/resize so the VISIBLE frame is `target` (Windows 10/11 add invisible resize borders). */
function setVisibleRect(w: Win32, h: bigint, target: Rect): void {
  // Two passes: moving to a monitor with another DPI rescales the borders.
  for (let pass = 0; pass < 2; pass++) {
    const win = w.windowRect(h);
    const frame = w.frameRect(h);
    if (!win || !frame) return;
    if (pass > 0 && frame.x === target.x && frame.y === target.y && frame.w === target.w && frame.h === target.h) return;
    const o = outerRect(target, borderInsets(win, frame));
    w.fn.SetWindowPos(h, null, o.x, o.y, o.w, o.h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }
}

/**
 * Windows only lets the foreground process hand focus over. Try directly,
 * then after an injected Alt tap (we then sent the last input event), then
 * by attaching to the foreground thread's input queue.
 */
async function bringToFront(w: Win32, h: bigint): Promise<void> {
  const settled = async () => {
    await sleep(50);
    return w.foreground() === h;
  };
  if (w.foreground() === h) return;
  w.fn.SetForegroundWindow(h);
  if (await settled()) return;
  try {
    w.sendInput([keyInput({ vk: VK_MENU, extended: false }, true), keyInput({ vk: VK_MENU, extended: false }, false)]);
    w.fn.SetForegroundWindow(h);
    if (await settled()) return;
  } catch {
    // input blocked (elevated foreground window): try attaching instead
  }
  const fg = w.foreground();
  const fgThread = fg ? w.owner(fg).thread : 0;
  const me = w.fn.GetCurrentThreadId();
  const attached = fgThread && fgThread !== me && !!w.fn.AttachThreadInput(me, fgThread, 1);
  try {
    w.fn.BringWindowToTop(h);
    w.fn.SetForegroundWindow(h);
  } finally {
    if (attached) w.fn.AttachThreadInput(me, fgThread, 0);
  }
  if (!(await settled())) throw new Error(`Windows refused to bring window ${h} to the foreground`);
}

async function focusWindow(id: string, place?: Placement): Promise<void> {
  const w = await win32();
  const h = hwnd(id);
  if (!w.fn.IsWindow(h)) throw new Error(`No window with id ${id}`);
  if (w.fn.IsIconic(h)) w.fn.ShowWindow(h, SW_RESTORE);
  if (place) {
    let target: Rect | undefined;
    if ("screen" in place) {
      const mon = w.monitors().find((m) => m.screen.name === place.screen);
      if (mon) target = placeInArea(mon.work, place.margin, place.aspect); // unknown monitor: ignored, as on KDE
    } else {
      target = { x: Math.round(place.x), y: Math.round(place.y), w: Math.round(place.w), h: Math.round(place.h) };
    }
    if (target) {
      // A maximized window keeps its maximized size; restore it first.
      if (w.fn.IsZoomed(h)) w.fn.ShowWindow(h, SW_RESTORE);
      setVisibleRect(w, h, target);
    }
  }
  await bringToFront(w, h);
}

async function fitWindow(match: string, aspect = 16 / 9): Promise<{ window: WindowInfo; restore: () => Promise<void> }> {
  const win = findWindow(await listWindows(), match);
  if (!win) throw new Error(`No window matching "${match}" to fit`);
  const w = await win32();
  const h = hwnd(win.id);
  // WINDOWPLACEMENT holds the normal rect and the min/max state: putting it back restores both exactly.
  const saved = w.getPlacement(h);
  w.fn.ShowWindow(h, SW_RESTORE);
  await focusWindow(win.id, { screen: win.output, aspect });
  return {
    window: win,
    restore: async () => {
      if (saved && w.fn.IsWindow(h)) w.setPlacement(h, saved);
    },
  };
}

export const windowsDesktop: Desktop = {
  id: "windows",

  async screens() {
    return (await win32()).monitors().map((m) => m.screen);
  },

  listWindows,
  focusWindow,
  fitWindow,

  // No public API lists or closes toast popups.
  closeNotificationPopups: async () => 0,
  // Focus Assist / Do Not Disturb has no stable public API (only undocumented WNF state), so nothing is held.
  quietNotifications: async () => async () => {},
  // Text is typed as Unicode key events and shortcuts use VK codes, so the layout never matters.
  useLatinLayout: async () => async () => {},

  async openInjector(screens) {
    return new WindowsInjector(await win32(), screens);
  },

  createWatcher() {
    return new WindowsWatcher();
  },

  sourceMonitor,
};
