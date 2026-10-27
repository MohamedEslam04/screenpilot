import dbus from "dbus-next";
import { portalVersion } from "../drive/portal.js";
import type { FocusEvent } from "../record/input/kwin.js";
import type { RawEvent, ScreenInfo } from "../record/input/types.js";
import { quietNotifications } from "../record/quiet.js";
import { run } from "../util/exec.js";
import { desktopName, isWlrootsEnv } from "./detect.js";
import { parseHyprMonitors, parseMutterState, parseSwayOutputs, screensFromStreams } from "./displays.js";
import { openCaptureSession, openPortalInjector } from "./portal.js";
import type { Desktop, Watcher } from "./types.js";

// Any Wayland desktop that is not KDE (GNOME/Mutter first, also wlroots
// compositors) through xdg-desktop-portal: input through RemoteDesktop (as
// on KDE), monitors from the compositor's own API where it has one. Wayland
// gives apps no window list and no pointer position, so window control and
// pointer logging are not available here.

const name = () => desktopName(process.env);

const noWindows = (what: string) =>
  new Error(
    `${what} is not supported on ${name()} (Wayland): the desktop gives apps no window list. Use screen targets ({screen, x, y}); window control works on KDE Plasma, X11 sessions and Windows.`,
  );

/** GNOME: org.gnome.Mutter.DisplayConfig.GetCurrentState; undefined when Mutter is not there. */
async function mutterScreens(): Promise<ScreenInfo[] | undefined> {
  const bus = dbus.sessionBus();
  try {
    const reply = await bus.call(
      new dbus.Message({
        destination: "org.gnome.Mutter.DisplayConfig",
        path: "/org/gnome/Mutter/DisplayConfig",
        interface: "org.gnome.Mutter.DisplayConfig",
        member: "GetCurrentState",
      }),
    );
    return parseMutterState(reply?.body ?? []);
  } catch {
    return undefined;
  } finally {
    bus.disconnect();
  }
}

async function compositorScreens(): Promise<ScreenInfo[] | undefined> {
  const env = process.env;
  try {
    if (env.SWAYSOCK) return parseSwayOutputs((await run("swaymsg", ["-t", "get_outputs", "-r"])).stdout);
    if (env.HYPRLAND_INSTANCE_SIGNATURE) return parseHyprMonitors((await run("hyprctl", ["monitors", "-j"])).stdout);
  } catch {
    // CLI missing: fall back to the portal
  }
  return undefined;
}

/** Mutter / sway / Hyprland layout, else what the portal streams say (may show the sharing dialog once). */
export async function portalScreens(log: (m: string) => void = () => {}): Promise<ScreenInfo[]> {
  const known = (await mutterScreens()) ?? (await compositorScreens());
  if (known?.length) return known;
  const session = await openCaptureSession(log);
  try {
    return screensFromStreams(session.streams);
  } finally {
    await session.close();
  }
}

/** Monitors only: no pointer position and no active window exist for apps on these compositors. */
export class PortalWatcher implements Watcher {
  readonly id = "portal";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  readonly focus: FocusEvent[] = [];
  private screenList: ScreenInfo[] = [];

  screens(): ScreenInfo[] {
    return this.screenList;
  }

  cursor(): undefined {
    return undefined;
  }

  async start(): Promise<void> {
    this.screenList = await portalScreens((m) => this.warnings.push(m));
    this.warnings.push(
      `No pointer logging on ${name()} (Wayland does not expose the pointer to apps): clicks of performed takes come from the driver, other zooms from the storyboard.`,
    );
  }

  async stop(): Promise<void> {}
}

export const portalDesktop: Desktop = {
  id: "portal",
  windowControl: false,

  screens: () => portalScreens(),

  listWindows: async () => [],
  focusWindow: async () => {
    throw noWindows("Focusing windows");
  },
  fitWindow: async () => {
    throw noWindows("Fitting windows");
  },

  closeNotificationPopups: async () => 0,
  // freedesktop Notifications.Inhibit where the server has it (no-op elsewhere, e.g. GNOME Shell).
  quietNotifications,
  // Keysyms are injected as such; nothing to switch.
  useLatinLayout: async () => async () => {},

  async openInjector(screens, log) {
    if ((await portalVersion("RemoteDesktop")) === undefined) {
      const why = isWlrootsEnv(process.env) ? " (wlroots compositors such as sway and Hyprland have none)" : "";
      throw new Error(
        `Driving the desktop is not supported on ${name()}: its xdg-desktop-portal has no RemoteDesktop interface${why}. Recording still works (ScreenCast).`,
      );
    }
    return openPortalInjector(screens, log);
  },

  createWatcher() {
    return new PortalWatcher();
  },
};
