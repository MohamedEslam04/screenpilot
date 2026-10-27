import { performance } from "node:perf_hooks";
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
  private hook?: typeof import("uiohook-napi").uIOhook;

  screens(): ScreenInfo[] {
    return [];
  }

  cursor(): { x: number; y: number } | undefined {
    return this.pos;
  }

  async start(): Promise<void> {
    const { uIOhook } = await import("uiohook-napi");
    this.hook = uIOhook;
    uIOhook.on("mousemove", (e) => {
      this.pos = { x: e.x, y: e.y };
      const now = performance.now();
      if (now - this.lastMove < MOVE_INTERVAL_MS) return;
      this.lastMove = now;
      this.events.push({ at: now, type: "move", px: e.x, py: e.y });
    });
    uIOhook.on("mousedown", (e) => {
      this.pos = { x: e.x, y: e.y };
      this.events.push({ at: performance.now(), type: "down", px: e.x, py: e.y, button: Number(e.button) });
    });
    uIOhook.on("mouseup", (e) => {
      this.events.push({ at: performance.now(), type: "up", px: e.x, py: e.y, button: Number(e.button) });
    });
    uIOhook.on("wheel", (e) => {
      this.events.push({ at: performance.now(), type: "scroll", px: e.x, py: e.y });
    });
    uIOhook.start();
  }

  async stop(): Promise<void> {
    this.hook?.stop();
    this.hook?.removeAllListeners();
  }
}
