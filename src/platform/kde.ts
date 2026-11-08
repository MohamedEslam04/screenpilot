import { useLatinLayout } from "../drive/keyboard.js";
import { closeNotificationPopups, fitWindow, focusWindow, listWindows, runKwinScript } from "../drive/kwinscript.js";
import type { RemoteDesktopSession } from "../drive/portal.js";
import { KwinAdapter } from "../record/input/kwin.js";
import type { Rect } from "../record/input/types.js";
import { quietNotifications } from "../record/quiet.js";
import { mapStreams, openPortalInjector, openRemoteDesktop as openPortalRemoteDesktop, PortalInjector } from "./portal.js";
import type { Desktop } from "./types.js";

// KDE Plasma (Wayland): input through the xdg RemoteDesktop portal (shared
// with the generic portal backend in portal.ts), windows and monitors
// through KWin scripts.

export { mapStreams, PortalInjector };

/** RemoteDesktop portal session; KDE asks once, then the saved restore token is used. */
export function openRemoteDesktop(log: (m: string) => void): Promise<RemoteDesktopSession> {
  return openPortalRemoteDesktop(log, "the KDE dialog");
}

/** KWin script: the usable area (no panels) of output `screen` on the current desktop as [x, y, w, h], or "" for an unknown output. */
export function kdeWorkAreaScript(screen: string): string {
  return `
var out = workspace.screens.filter(function (o) { return o.name === ${JSON.stringify(screen)}; })[0];
if (out) {
  var a = workspace.clientArea(KWin.MaximizeArea, out, workspace.currentDesktop);
  reply(JSON.stringify([a.x, a.y, a.width, a.height]));
} else reply("");
`;
}

export function parseKdeWorkArea(reply: string): Rect | undefined {
  try {
    const v: unknown = JSON.parse(reply);
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number")) return undefined;
    const [x, y, w, h] = v as [number, number, number, number];
    return { x, y, w, h };
  } catch {
    return undefined;
  }
}

export const kdeDesktop: Desktop = {
  id: "kde",
  windowControl: true,

  async screens() {
    const k = new KwinAdapter();
    await k.start();
    const screens = k.screens();
    await k.stop();
    return screens;
  },

  async workArea(screen) {
    return parseKdeWorkArea(await runKwinScript(kdeWorkAreaScript(screen)));
  },

  listWindows,
  focusWindow,
  fitWindow,
  closeNotificationPopups,
  quietNotifications,
  useLatinLayout,

  async openInjector(screens, log) {
    return openPortalInjector(screens, log, "the KDE dialog");
  },

  createWatcher() {
    return new KwinAdapter();
  },
};
