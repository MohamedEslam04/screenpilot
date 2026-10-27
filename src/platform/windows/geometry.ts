import type { Rect, ScreenInfo } from "../../record/input/types.js";

// Window/monitor geometry rules for Windows, kept free of koffi so they can
// be unit tested anywhere.

export interface LTRB {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const rectFromLTRB = (r: LTRB): Rect => ({ x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top });

/**
 * Windows 10/11 windows have invisible resize borders: GetWindowRect is
 * larger than what is drawn (DWM extended frame bounds). Returns their sizes.
 */
export function borderInsets(windowRect: Rect, frame: Rect): Insets {
  return {
    left: frame.x - windowRect.x,
    top: frame.y - windowRect.y,
    right: windowRect.x + windowRect.w - (frame.x + frame.w),
    bottom: windowRect.y + windowRect.h - (frame.y + frame.h),
  };
}

/** The SetWindowPos rect that makes the visible frame equal `visible`. */
export function outerRect(visible: Rect, ins: Insets): Rect {
  return { x: visible.x - ins.left, y: visible.y - ins.top, w: visible.w + ins.left + ins.right, h: visible.h + ins.top + ins.bottom };
}

/** Centered `aspect` rect inside `area`, inset by `margin` × the shorter side (as KDE's focusWindow). */
export function placeInArea(area: Rect, margin = 0.02, aspect = 16 / 9): Rect {
  const m = Math.round(Math.min(area.w, area.h) * margin);
  const bw = area.w - 2 * m;
  const bh = area.h - 2 * m;
  const w = Math.min(bw, Math.round(bh * aspect));
  const h = Math.min(bh, Math.round(w / aspect));
  return { x: area.x + Math.round((area.w - w) / 2), y: area.y + Math.round((area.h - h) / 2), w, h };
}

export function clipRect(r: Rect, area: Rect): Rect | undefined {
  const x0 = Math.max(r.x, area.x);
  const y0 = Math.max(r.y, area.y);
  const x1 = Math.min(r.x + r.w, area.x + area.w);
  const y1 = Math.min(r.y + r.h, area.y + area.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

export const WS_EX_TOOLWINDOW = 0x80;
export const WS_EX_APPWINDOW = 0x40000;

// Desktop (Progman/WorkerW) and taskbars are visible, titled top-level windows too.
const SHELL_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

export interface WindowFacts {
  title: string;
  className: string;
  visible: boolean;
  /** DWMWA_CLOAKED: hidden by DWM (other virtual desktop, suspended UWP app). */
  cloaked: boolean;
  exStyle: number;
}

/** Roughly what Alt+Tab shows. Minimized windows are kept (flagged `minimized`). */
export function isListable(f: WindowFacts): boolean {
  if (!f.visible || f.cloaked || !f.title.trim()) return false;
  if (SHELL_CLASSES.has(f.className)) return false;
  return !(f.exStyle & WS_EX_TOOLWINDOW) || !!(f.exStyle & WS_EX_APPWINDOW);
}

/**
 * A monitor as ScreenInfo: named by its GDI device ("\\.\DISPLAY1"), model
 * from the monitor's DeviceString unless it is just the generic driver name.
 */
export function toScreen(device: string, rect: Rect, deviceString: string | undefined, deviceId: string | undefined): ScreenInfo {
  const model = deviceString?.trim();
  return {
    name: device,
    ...rect,
    ...(model && !/^generic\b/i.test(model) ? { model } : {}),
    ...(deviceId ? { deviceId } : {}),
  };
}
