import { useLatinLayout } from "../drive/keyboard.js";
import { closeNotificationPopups, fitWindow, focusWindow, listWindows } from "../drive/kwinscript.js";
import type { RemoteDesktopSession } from "../drive/portal.js";
import { KwinAdapter } from "../record/input/kwin.js";
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
