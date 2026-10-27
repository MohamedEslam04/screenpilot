import { performance } from "node:perf_hooks";
import { useHook } from "./hook.js";
import type { InputAdapter, RawEvent, ScreenInfo } from "./types.js";

// Global mouse hook for Windows, macOS and X11 (libuiohook). It cannot see
// native Wayland apps, so it is not used on Wayland sessions.

const MOVE_INTERVAL_MS = 1000 / 60;

export class UiohookAdapter implements InputAdapter {
  readonly id = "uiohook";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  private pos?: { x: number; y: number };
  private lastMove = 0;
  private unhook?: () => void;

  screens(): ScreenInfo[] {
    return [];
  }

  cursor(): { x: number; y: number } | undefined {
    return this.pos;
  }

  async start(): Promise<void> {
    type E = { x: number; y: number; button?: unknown };
    this.unhook = await useHook({
      mousemove: (e: E) => {
        this.pos = { x: e.x, y: e.y };
        const now = performance.now();
        if (now - this.lastMove < MOVE_INTERVAL_MS) return;
        this.lastMove = now;
        this.events.push({ at: now, type: "move", px: e.x, py: e.y });
      },
      mousedown: (e: E) => {
        this.pos = { x: e.x, y: e.y };
        this.events.push({ at: performance.now(), type: "down", px: e.x, py: e.y, button: Number(e.button) });
      },
      mouseup: (e: E) => {
        this.events.push({ at: performance.now(), type: "up", px: e.x, py: e.y, button: Number(e.button) });
      },
      wheel: (e: E) => {
        this.events.push({ at: performance.now(), type: "scroll", px: e.x, py: e.y });
      },
    });
  }

  async stop(): Promise<void> {
    this.unhook?.();
    this.unhook = undefined;
  }
}
