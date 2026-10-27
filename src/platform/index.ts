import { isKde } from "../record/input/kwin.js";
import type { Desktop } from "./types.js";

export * from "./types.js";

let cached: Desktop | undefined;

/** The desktop we are running on (KDE Plasma or Windows). */
export async function getDesktop(): Promise<Desktop> {
  if (cached) return cached;
  if (process.platform === "win32") {
    cached = (await import("./windows/desktop.js")).windowsDesktop;
  } else if (process.platform === "linux" && isKde()) {
    cached = (await import("./kde.js")).kdeDesktop;
  } else {
    throw new Error(
      `Desktop control is supported on KDE Plasma and Windows (this is ${process.platform}${process.env.XDG_CURRENT_DESKTOP ? ` / ${process.env.XDG_CURRENT_DESKTOP}` : ""}).`,
    );
  }
  return cached;
}
