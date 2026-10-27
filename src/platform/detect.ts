import { DESKTOP_ENV } from "../brand.js";

// Which desktop backend to use. Pure (env + platform in, choice out) so the
// rules are testable; getDesktop(), the recorder and the input watcher all
// ask this one function.

export type DesktopId = "kde" | "x11" | "portal" | "windows" | "macos";

export const DESKTOP_IDS: readonly DesktopId[] = ["kde", "x11", "portal", "windows", "macos"];

export interface DesktopChoice {
  id: DesktopId;
  /** Why (shown by `doctor`). */
  reason: string;
}

type Env = Record<string, string | undefined>;

export function isKdeEnv(env: Env): boolean {
  return /kde/i.test(env.XDG_CURRENT_DESKTOP ?? "") || env.KDE_FULL_SESSION === "true";
}

/** wlroots-based compositors: ScreenCast portal, but no RemoteDesktop portal. */
export function isWlrootsEnv(env: Env): boolean {
  if (env.SWAYSOCK || env.HYPRLAND_INSTANCE_SIGNATURE) return true;
  return /\b(sway|hyprland|wlroots|river|wayfire|labwc|niri|dwl|cage)\b/i.test(env.XDG_CURRENT_DESKTOP ?? "");
}

/** The session's desktop name for messages ("GNOME", "sway", ...). */
export function desktopName(env: Env): string {
  return env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "this desktop";
}

/**
 * Windows → windows, macOS → macos. Linux: SCREENPILOT_DESKTOP wins; KDE Wayland → kde (portal
 * + KWin); an X11 session (or DISPLAY without WAYLAND_DISPLAY) → x11; any
 * other Wayland → portal. Throws when there is no graphical session.
 */
export function detectDesktop(env: Env = process.env, platform: NodeJS.Platform = process.platform): DesktopChoice {
  const forced = env[DESKTOP_ENV]?.trim().toLowerCase();
  if (forced) {
    if (!(DESKTOP_IDS as readonly string[]).includes(forced)) {
      throw new Error(`${DESKTOP_ENV}=${forced} is not one of ${DESKTOP_IDS.join(", ")}`);
    }
    return { id: forced as DesktopId, reason: `forced by ${DESKTOP_ENV}` };
  }
  if (platform === "win32") return { id: "windows", reason: "Windows" };
  if (platform === "darwin") return { id: "macos", reason: "macOS" };
  if (platform !== "linux") throw new Error(`Desktop control is not supported on ${platform} (Linux, Windows and macOS only).`);
  const session = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
  const wayland = session === "wayland" || (session !== "x11" && !!env.WAYLAND_DISPLAY);
  if (wayland && isKdeEnv(env)) return { id: "kde", reason: "KDE Plasma on Wayland" };
  if (session === "x11") return { id: "x11", reason: `X11 session (${desktopName(env)})` };
  if (!wayland && env.DISPLAY) return { id: "x11", reason: `X display ${env.DISPLAY} without Wayland` };
  if (wayland) return { id: "portal", reason: `Wayland session (${desktopName(env)}) through xdg-desktop-portal` };
  throw new Error("No graphical session found (neither WAYLAND_DISPLAY nor DISPLAY is set).");
}
