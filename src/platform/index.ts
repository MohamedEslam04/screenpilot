import { detectDesktop } from "./detect.js";
import type { Desktop } from "./types.js";

export * from "./types.js";
export { detectDesktop, type DesktopChoice, type DesktopId } from "./detect.js";

let cached: Desktop | undefined;

/** The desktop we are running on: KDE Plasma (Wayland), X11, another Wayland desktop (portal), Windows or macOS. */
export async function getDesktop(): Promise<Desktop> {
  if (cached) return cached;
  switch (detectDesktop().id) {
    case "windows":
      cached = (await import("./windows/desktop.js")).windowsDesktop;
      break;
    case "macos":
      cached = (await import("./macos/desktop.js")).macosDesktop;
      break;
    case "kde":
      cached = (await import("./kde.js")).kdeDesktop;
      break;
    case "x11":
      cached = (await import("./x11/desktop.js")).x11Desktop;
      break;
    case "portal":
      cached = (await import("./wayland.js")).portalDesktop;
      break;
  }
  return cached!;
}
