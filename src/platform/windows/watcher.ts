import { performance } from "node:perf_hooks";
import type { FocusEvent } from "../../record/input/kwin.js";
import type { RawEvent, Rect, ScreenInfo } from "../../record/input/types.js";
import type { Watcher } from "../types.js";
import { clipRect } from "./geometry.js";
import { win32, type Monitor, type Win32 } from "./win32.js";
import { useHook } from "../../record/input/hook.js";

// Pointer and active window by polling Win32 (60 Hz / 10 Hz); clicks and
// wheel from the global mouse hook (uiohook). Events have the same shape as
// KwinAdapter's, so normalizeEvents/normalizeWindows work unchanged.

const CURSOR_MS = 1000 / 60;
const FOCUS_MS = 100;

type WatchApi = Pick<Win32, "cursorPos" | "monitors" | "monitorOf" | "foreground" | "frameRect" | "title" | "owner" | "exeName">;

/** A window's visible frame, its monitor, and the part of it inside the monitor's work area. */
export function windowArea(w: WatchApi, h: bigint, monitors: Monitor[]): { frame?: Rect; monitor?: Monitor; visible?: Rect } {
  const frame = w.frameRect(h);
  const mon = w.monitorOf(h);
  const monitor = monitors.find((m) => m.handle === mon);
  return { frame, monitor, visible: frame && monitor ? clipRect(frame, monitor.work) : frame };
}

export class WindowsWatcher implements Watcher {
  readonly id = "win32";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  readonly focus: FocusEvent[] = [];
  private w?: WatchApi;
  private monitorList: Monitor[] = [];
  private pos?: { x: number; y: number };
  private lastFocus = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private unhook?: () => void;

  /** `load` and `clicks` are for tests (a fake Win32, no global hook). */
  constructor(
    private load: () => Promise<WatchApi> = win32,
    private clicks = true,
  ) {}

  screens(): ScreenInfo[] {
    return this.monitorList.map((m) => m.screen);
  }

  cursor(): { x: number; y: number } | undefined {
    return this.pos;
  }

  async start(): Promise<void> {
    this.w = await this.load();
    this.monitorList = this.w.monitors();
    this.pollCursor();
    this.pollFocus();
    this.timers.push(setInterval(() => this.pollCursor(), CURSOR_MS), setInterval(() => this.pollFocus(), FOCUS_MS));
    if (!this.clicks) return;
    // uiohook reports its own coordinates; the cursor read right now is in the same physical px as everything else.
    const at = (type: RawEvent["type"], button?: number) => {
      const p = this.w?.cursorPos() ?? this.pos;
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
      this.warnings.push(`No click/scroll logging (mouse hook failed: ${(err as Error).message})`);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unhook?.();
    this.unhook = undefined;
  }

  private pollCursor(): void {
    const p = this.w?.cursorPos();
    if (!p || (this.pos && p.x === this.pos.x && p.y === this.pos.y)) return;
    this.pos = p;
    this.events.push({ at: performance.now(), type: "move", px: p.x, py: p.y });
  }

  private pollFocus(): void {
    const w = this.w;
    if (!w) return;
    try {
      const h = w.foreground();
      if (!h) return;
      let area = windowArea(w, h, this.monitorList);
      if (area.frame && !area.monitor) {
        this.monitorList = w.monitors(); // monitor plugged in / layout changed
        area = windowArea(w, h, this.monitorList);
      }
      const r = area.visible;
      if (!r) return; // e.g. the taskbar: nothing of it is in the work area
      const title = w.title(h);
      const key = `${h}|${title}|${r.x},${r.y},${r.w},${r.h}`;
      if (key === this.lastFocus) return;
      this.lastFocus = key;
      this.focus.push({ at: performance.now(), id: String(h), cls: w.exeName(w.owner(h).pid), title, ...r });
    } catch {
      // the window went away between calls
    }
  }
}
