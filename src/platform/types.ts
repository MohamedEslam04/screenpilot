import type { FocusEvent } from "../record/input/kwin.js";
import type { DesktopId } from "./detect.js";
import type { InputAdapter, ScreenInfo } from "../record/input/types.js";

// What the tool needs from a desktop: monitors, windows, input injection and
// a watcher for the pointer and the active window. One implementation per OS
// (KDE Plasma, X11, other Wayland desktops through xdg-desktop-portal, Windows,
// macOS). Global coordinates are the desktop's own unit: logical px on KDE,
// physical px on Windows and X11, points on macOS.

export interface WindowInfo {
  id: string;
  caption: string;
  /** App identity: KDE resource class, X11 WM_CLASS class, the exe name on Windows (e.g. chrome.exe), the app name on macOS (e.g. Google Chrome). */
  resourceClass: string;
  pid: number;
  active: boolean;
  minimized: boolean;
  /** Window area in global desktop pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Monitor the window is on. */
  output: string;
}

export type Placement = { x: number; y: number; w: number; h: number } | { screen: string; margin?: number; aspect?: number };

export type MouseButton = "left" | "right" | "middle";

/** Synthetic input. Coordinates are global desktop pixels (as in ScreenInfo). */
export interface Injector {
  /** Returns false when the point is on no controllable monitor (e.g. a gap between monitors). */
  moveTo(x: number, y: number): Promise<boolean>;
  button(b: MouseButton, down: boolean): Promise<void>;
  /** One wheel step; positive = down / right. */
  wheel(horizontal: boolean, step: 1 | -1): Promise<void>;
  /** Press and release a combo like "ctrl+shift+t". */
  pressCombo(combo: string): Promise<void>;
  /** Type text; `before` runs before each character (interrupt checks), `gap` is the pause after it (ms). */
  typeText(text: string, hooks: { before: () => void; gap: () => number }): Promise<void>;
  close(): Promise<void>;
}

/** Pointer, clicks and active window over time (same events on every OS). */
export type Watcher = InputAdapter & { readonly focus: FocusEvent[] };

export interface Desktop {
  readonly id: DesktopId;
  /** Whether windows can be listed, focused and moved (not on Wayland desktops other than KDE). */
  readonly windowControl: boolean;
  screens(): Promise<ScreenInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  focusWindow(id: string, place?: Placement): Promise<void>;
  /** Resize a window to `aspect` inside its monitor's work area; `restore` puts it back as it was. */
  fitWindow(match: string, aspect?: number): Promise<{ window: WindowInfo; restore: () => Promise<void> }>;
  /** Close notification popups on screen; returns how many (0 where the OS gives no way). */
  closeNotificationPopups(): Promise<number>;
  /** Hold new notification popups; returns the release function (no-op where unsupported). */
  quietNotifications(reason?: string): Promise<() => Promise<void>>;
  /** Make sure typed Latin text needs no layout switch; returns the restore function. */
  useLatinLayout(): Promise<() => Promise<void>>;
  /** Input injection for these monitors (may ask the user for permission once). */
  openInjector(screens: ScreenInfo[], log: (m: string) => void): Promise<Injector>;
  createWatcher(): Watcher;
  /** Which monitor an OBS capture source shows, from its settings, when the OS can tell. */
  sourceMonitor?(inputKind: string, settings: Record<string, unknown>, screens: ScreenInfo[]): string | undefined;
}

/** First window whose class, then caption, contains `match` (case-insensitive). */
export function findWindow(windows: WindowInfo[], match: string): WindowInfo | undefined {
  const m = match.toLowerCase();
  return windows.find((w) => w.resourceClass.toLowerCase().includes(m)) ?? windows.find((w) => w.caption.toLowerCase().includes(m));
}
