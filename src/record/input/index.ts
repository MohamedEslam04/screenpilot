import type { InputAdapterId } from "../index.js";
import { isKde, KwinAdapter } from "./kwin.js";
import type { InputAdapter, RawEvent, ScreenInfo } from "./types.js";
import { UiohookAdapter } from "./uiohook.js";

class NoInput implements InputAdapter {
  readonly id = "none";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  async start() {}
  async stop() {}
  screens(): ScreenInfo[] {
    return [];
  }
  cursor() {
    return undefined;
  }
}

export function pickAdapter(id: InputAdapterId): InputAdapter {
  if (id === "kwin") return new KwinAdapter();
  if (id === "uiohook") return new UiohookAdapter();
  if (id === "none") return new NoInput();
  const wayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
  if (process.platform === "linux" && isKde()) return new KwinAdapter();
  if (wayland) {
    const none = new NoInput();
    none.warnings.push(
      "No pointer logging on this Wayland compositor yet; zooms/ripples will come from the storyboard only.",
    );
    return none;
  }
  return new UiohookAdapter();
}

/** Start an adapter, falling back to no input if it fails. */
export async function startAdapter(id: InputAdapterId): Promise<InputAdapter> {
  // On Windows the desktop's watcher logs pointer, clicks and the active window.
  const adapter =
    id === "auto" && process.platform === "win32" ? (await import("../../platform/index.js").then((m) => m.getDesktop())).createWatcher() : pickAdapter(id);
  try {
    await adapter.start();
    return adapter;
  } catch (err) {
    if (id !== "auto") throw err;
    const none = new NoInput();
    none.warnings.push(`Input logging (${adapter.id}) failed: ${(err as Error).message}`);
    return none;
  }
}
