import { performance } from "node:perf_hooks";
import { getDesktop } from "../platform/index.js";
import type { Desktop, Injector, MouseButton, Watcher } from "../platform/types.js";
import type { ScreenInfo } from "../record/input/types.js";

// The agent's hands: smooth pointer motion, clicks, keys and typing on the
// real desktop, with the pointer position and monitor layout read back from
// the OS. The OS specifics (KDE portal, Windows SendInput) are behind
// Injector / Watcher.

/** A point on a monitor, normalized 0..1. Without `screen`, the monitor under the pointer. */
export interface Target {
  screen?: string;
  x: number;
  y: number;
}

export type Button = MouseButton;
const BUTTON_NO: Record<Button, number> = { left: 1, right: 2, middle: 3 };

export interface DriverAction {
  at: number; // performance.now()
  type: "move" | "down" | "up" | "scroll" | "key";
  px: number;
  py: number;
  button?: number;
}

export class UserInterrupted extends Error {
  constructor() {
    super("Stopped: the pointer was moved by someone else (you took the mouse).");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Deterministic jitter so scripted takes look the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface DriverOptions {
  log?: (m: string) => void;
  /** Max distance (px) between where we put the pointer and where the OS sees it before we stop. */
  interruptPx?: number;
  seed?: number;
}

export class Driver {
  readonly actions: DriverAction[] = [];
  private pos = { x: 0, y: 0 };
  private rand: () => number;
  private aborted = false;

  private constructor(
    readonly desktop: Desktop,
    private input: Injector,
    private watcher: Watcher,
    private opts: DriverOptions,
  ) {
    this.rand = rng(opts.seed ?? 7);
    const c = watcher.cursor();
    if (c) this.pos = { ...c };
  }

  static async open(opts: DriverOptions = {}): Promise<Driver> {
    const log = opts.log ?? (() => {});
    const desktop = await getDesktop();
    const watcher = desktop.createWatcher();
    await watcher.start();
    try {
      const input = await desktop.openInjector(watcher.screens(), log);
      return new Driver(desktop, input, watcher, opts);
    } catch (err) {
      await watcher.stop();
      throw err;
    }
  }

  screens(): ScreenInfo[] {
    return this.watcher.screens();
  }

  cursor(): { x: number; y: number } {
    return this.watcher.cursor() ?? this.pos;
  }

  /** Normalized monitor target → global desktop pixels. */
  toGlobal(t: Target): { x: number; y: number } {
    const scr = t.screen ? this.screens().find((s) => s.name === t.screen) : this.screenAtCursor();
    if (!scr) throw new Error(`Unknown monitor "${t.screen}" (have: ${this.screens().map((s) => s.name).join(", ")})`);
    const x = scr.x + Math.min(0.9995, Math.max(0, t.x)) * scr.w;
    const y = scr.y + Math.min(0.9995, Math.max(0, t.y)) * scr.h;
    return { x, y };
  }

  abort(): void {
    this.aborted = true;
  }

  async moveTo(t: Target, opts: { dur?: number } = {}): Promise<void> {
    await this.moveToGlobal(this.toGlobal(t), opts);
  }

  async moveToGlobal(to: { x: number; y: number }, opts: { dur?: number } = {}): Promise<void> {
    this.checkInterrupted();
    const from = { ...this.pos };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const dur = opts.dur ?? Math.min(1.1, Math.max(0.25, 0.25 + dist / 1800));
    const steps = Math.max(1, Math.round(dur * 60));
    // Slight arc so the motion reads as a hand, not a robot.
    const bend = (this.rand() - 0.5) * Math.min(120, dist * 0.15);
    const nx = dist ? -(to.y - from.y) / dist : 0;
    const ny = dist ? (to.x - from.x) / dist : 0;
    const t0 = performance.now();
    for (let i = 1; i <= steps; i++) {
      const p = easeInOutCubic(i / steps);
      const arc = Math.sin(Math.PI * p) * bend;
      await this.place(from.x + (to.x - from.x) * p + nx * arc, from.y + (to.y - from.y) * p + ny * arc);
      const due = t0 + (i / steps) * dur * 1000;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
    await this.place(to.x, to.y);
  }

  async click(t?: Target, opts: { button?: Button; count?: number } = {}): Promise<void> {
    if (t) await this.moveTo(t);
    const b = opts.button ?? "left";
    for (let i = 0; i < (opts.count ?? 1); i++) {
      this.checkInterrupted();
      await this.press(b, true);
      await sleep(45 + this.rand() * 30);
      await this.press(b, false);
      if (i + 1 < (opts.count ?? 1)) await sleep(70);
    }
  }

  async drag(from: Target, to: Target, opts: { dur?: number } = {}): Promise<void> {
    await this.moveTo(from);
    await this.dragTo(this.toGlobal(to), opts);
  }

  /** Press at the current position, move to `to` (global px), release. */
  async dragTo(to: { x: number; y: number }, opts: { dur?: number } = {}): Promise<void> {
    await this.press("left", true);
    await sleep(120);
    await this.moveToGlobal(to, { dur: opts.dur ?? 0.8 });
    await sleep(80);
    await this.press("left", false);
  }

  /** Positive = down / right. */
  async scroll(steps: number, opts: { horizontal?: boolean; at?: Target } = {}): Promise<void> {
    if (opts.at) await this.moveTo(opts.at);
    const dir = steps < 0 ? -1 : 1;
    for (let i = 0; i < Math.abs(steps); i++) {
      this.checkInterrupted();
      await this.input.wheel(!!opts.horizontal, dir);
      this.actions.push({ at: performance.now(), type: "scroll", px: this.pos.x, py: this.pos.y });
      await sleep(60);
    }
  }

  async key(combo: string): Promise<void> {
    this.checkInterrupted();
    this.actions.push({ at: performance.now(), type: "key", px: this.pos.x, py: this.pos.y });
    await this.input.pressCombo(combo);
  }

  /** Types like a person (~`cps` chars/s). */
  async type(text: string, opts: { cps?: number } = {}): Promise<void> {
    const delay = 1000 / (opts.cps ?? 14);
    await this.input.typeText(text, {
      before: () => this.checkInterrupted(),
      gap: () => delay * (0.6 + this.rand() * 0.8),
    });
  }

  async close(): Promise<void> {
    await this.input.close();
    await this.watcher.stop();
  }

  private screenAtCursor(): ScreenInfo | undefined {
    const c = this.cursor();
    return this.screens().find((s) => c.x >= s.x && c.x < s.x + s.w && c.y >= s.y && c.y < s.y + s.h) ?? this.screens()[0];
  }

  private async place(x: number, y: number): Promise<void> {
    if (!(await this.input.moveTo(x, y))) return; // gap between monitors: skip this step
    this.pos = { x, y };
    this.actions.push({ at: performance.now(), type: "move", px: x, py: y });
  }

  private async press(b: Button, down: boolean): Promise<void> {
    await this.input.button(b, down);
    this.actions.push({ at: performance.now(), type: down ? "down" : "up", px: this.pos.x, py: this.pos.y, button: BUTTON_NO[b] });
  }

  /**
   * The OS reports the pointer a little after we move it, so compare what it
   * sees with every point we commanded recently, not just the last one.
   */
  private checkInterrupted(): void {
    if (this.aborted) throw new Error("Stopped (abort requested).");
    const seen = this.watcher.cursor();
    if (!seen || this.actions.length === 0) return;
    const limit = this.opts.interruptPx ?? 40;
    const since = performance.now() - 600;
    const recent = this.actions.filter((a) => a.type === "move" && a.at >= since);
    const points = recent.length ? recent.map((a) => ({ x: a.px, y: a.py })) : [this.pos];
    if (points.every((p) => Math.hypot(seen.x - p.x, seen.y - p.y) > limit)) throw new UserInterrupted();
  }
}

export { mapStreams } from "../platform/kde.js";
