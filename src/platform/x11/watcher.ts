import { performance } from "node:perf_hooks";
import { useHook } from "../../record/input/hook.js";
import type { FocusEvent } from "../../record/input/kwin.js";
import type { RawEvent, ScreenInfo } from "../../record/input/types.js";
import type { Watcher } from "../types.js";
import { clipRect } from "../windows/geometry.js";
import { monitorOf, parseWmClass } from "./ewmh.js";
import { activeWindow, monitors, type X11Monitor, windowFrame, windowTitle } from "./windows.js";
import { x11, type XApi } from "./xlib.js";

// Pointer (XQueryPointer, 60 Hz) and active window (_NET_ACTIVE_WINDOW,
// 10 Hz) by polling; clicks and wheel from the global hook (uiohook works on
// X11). Same events as KwinAdapter / WindowsWatcher.

const CURSOR_MS = 1000 / 60;
const FOCUS_MS = 100;

export class X11Watcher implements Watcher {
  readonly id = "x11";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  readonly focus: FocusEvent[] = [];
  private x?: XApi;
  private monitorList: X11Monitor[] = [];
  private pos?: { x: number; y: number };
  private lastFocus = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private unhook?: () => void;

  /** `load` and `clicks` are for tests (a fake X server, no global hook). */
  constructor(
    private load: () => Promise<XApi> = x11,
    private clicks = true,
  ) {}

  screens(): ScreenInfo[] {
    return this.monitorList.map((m) => m.screen);
  }

  cursor(): { x: number; y: number } | undefined {
    return this.pos;
  }

  async start(): Promise<void> {
    this.x = await this.load();
    this.monitorList = monitors(this.x);
    this.pollCursor();
    this.pollFocus();
    this.timers.push(setInterval(() => this.pollCursor(), CURSOR_MS), setInterval(() => this.pollFocus(), FOCUS_MS));
    if (!this.clicks) return;
    const at = (type: RawEvent["type"], button?: number) => {
      const p = this.x?.pointer() ?? this.pos;
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
    const p = this.x?.pointer();
    if (!p || (this.pos && p.x === this.pos.x && p.y === this.pos.y)) return;
    this.pos = p;
    this.events.push({ at: performance.now(), type: "move", px: p.x, py: p.y });
  }

  private pollFocus(): void {
    const x = this.x;
    if (!x) return;
    const win = activeWindow(x);
    if (!win) return;
    const frame = windowFrame(x, win);
    if (!frame) return; // went away
    const mon = monitorOf(frame, this.monitorList.map((m) => ({ ...m.screen, m })))?.m;
    const r = mon ? clipRect(frame, mon.work) : frame; // only what is not under a panel
    if (!r) return;
    const title = windowTitle(x, win);
    const key = `${win}|${title}|${r.x},${r.y},${r.w},${r.h}`;
    if (key === this.lastFocus) return;
    this.lastFocus = key;
    this.focus.push({ at: performance.now(), id: String(win), cls: parseWmClass(x.bytes(win, "WM_CLASS")?.data).cls, title, ...r });
  }
}
