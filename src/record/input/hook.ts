// uiohook is one global hook per process, and several watchers (driver,
// recorder, uiohook adapter) can run at once: share it, start it on first
// use and stop it after the last user leaves.

type Hook = typeof import("uiohook-napi").uIOhook;
type HookEvent = "mousedown" | "mouseup" | "mousemove" | "wheel";
type Listener = (e: any) => void;

let users = 0;
let started = false;

/**
 * True once the hook has run on macOS: there `uIOhook.stop()` blocks the whole
 * process (it waits on a run loop Node doesn't have; seen hanging CI), so the
 * hook is left installed but idle, and the CLI exits explicitly instead of
 * waiting for it.
 */
export const hookPinned = () => started && process.platform === "darwin";

export async function useHook(listeners: Partial<Record<HookEvent, Listener>>): Promise<() => void> {
  const hook: Hook = (await import("uiohook-napi")).uIOhook;
  const entries = Object.entries(listeners) as [HookEvent, Listener][];
  // The typed overloads are per event; one untyped view handles all four.
  const h = hook as unknown as { on(ev: string, fn: Listener): void; off(ev: string, fn: Listener): void };
  for (const [ev, fn] of entries) h.on(ev, fn);
  const off = () => {
    for (const [ev, fn] of entries) h.off(ev, fn);
  };
  if (users === 0 && !hookPinned()) {
    try {
      hook.start();
      started = true;
    } catch (err) {
      off();
      throw err;
    }
  }
  users++;
  return () => {
    off();
    if (--users === 0 && !hookPinned()) {
      hook.stop();
      started = false;
    }
  };
}
