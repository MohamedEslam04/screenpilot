import { performance } from "node:perf_hooks";
import type { FocusEvent } from "../../record/input/kwin.js";
import type { RawEvent, ScreenInfo } from "../../record/input/types.js";
import { useHook } from "../../record/input/hook.js";
import type { Watcher } from "../types.js";
import { activeWindow, clipRect, displayOf, type CgWindow, type Display } from "./geometry.js";

// Pointer and active window by polling Quartz (60 Hz / 10 Hz); clicks and
// wheel from the global mouse hook (uiohook, needs Accessibility / Input
// Monitoring). Events have the same shape as KwinAdapter's and are in global
// points, so normalizeEvents/normalizeWindows work unchanged.

const CURSOR_MS = 1000 / 60;
const FOCUS_MS = 100;

export interface WatchApi {
  cursor(): { x: number; y: number };
  windows(): CgWindow[];
  focusedPid(): number | undefined;
  axTrusted(): boolean;
}

export class MacWatcher implements Watcher {
  readonly id = "quartz";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  readonly focus: FocusEvent[] = [];
  private q?: WatchApi;
  private displays: Display[] = [];
  private trusted = false;
  private pos?: { x: number; y: number };
  private lastFocus = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private unhook?: () => void;

  /** `clicks` is for tests (no global hook). */
  constructor(
    private load: () => Promise<WatchApi>,
    private loadDisplays: () => Promise<Display[]>,
    private clicks = true,
  ) {}

  screens(): ScreenInfo[] {
    return this.displays.map((d) => d.screen);
  }

  cursor(): { x: number; y: number } | undefined {
    return this.pos;
  }

  async start(): Promise<void> {
    this.q = await this.load();
    this.displays = await this.loadDisplays();
    this.trusted = this.q.axTrusted();
    this.pollCursor();
    this.pollFocus();
    this.timers.push(setInterval(() => this.pollCursor(), CURSOR_MS), setInterval(() => this.pollFocus(), FOCUS_MS));
    if (!this.clicks) return;
    // libuiohook refuses to start (or never gets events) without Accessibility; don't even try then.
    if (!this.trusted) {
      this.warnings.push("No click/scroll logging: allow Accessibility for the app running this (System Settings > Privacy & Security).");
      return;
    }
    // The cursor read right now is in the same points as everything else (uiohook's own coordinates may not be).
    const at = (type: RawEvent["type"], button?: number) => {
      const p = this.readCursor() ?? this.pos;
      if (!p) return;
      this.events.push({ at: performance.now(), type, px: p.x, py: p.y, ...(button !== undefined ? { button } : {}) });
    };
    try {
      this.unhook = await useHook({
        mousedown: (e: { button: unknown }) => at("down", Number(e.button)),
        mouseup: (e: { button: unknown }) => at("up", Number(e.button)),
        wheel: () => at("scroll"),
      });
    } catch (err) {
      this.warnings.push(`No click/scroll logging (mouse hook failed: ${(err as Error).message}; allow Input Monitoring)`);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unhook?.();
    this.unhook = undefined;
  }

  private readCursor(): { x: number; y: number } | undefined {
    try {
      return this.q?.cursor();
    } catch {
      return undefined;
    }
  }

  private pollCursor(): void {
    const p = this.readCursor();
    if (!p || (this.pos && p.x === this.pos.x && p.y === this.pos.y)) return;
    this.pos = p;
    this.events.push({ at: performance.now(), type: "move", px: p.x, py: p.y });
  }

  private pollFocus(): void {
    const q = this.q;
    if (!q) return;
    try {
      const w = activeWindow(q.windows(), this.trusted ? q.focusedPid() : undefined);
      if (!w) return;
      const d = displayOf(w.bounds, this.displays);
      // Only the part outside the menu bar and Dock: framing it must not show them.
      const r = d ? clipRect(w.bounds, d.work) : w.bounds;
      if (!r) return;
      const key = `${w.id}|${w.name}|${r.x},${r.y},${r.w},${r.h}`;
      if (key === this.lastFocus) return;
      this.lastFocus = key;
      this.focus.push({ at: performance.now(), id: String(w.id), cls: w.owner, title: w.name, ...r });
    } catch {
      // the window went away between calls
    }
  }
}
