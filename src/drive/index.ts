import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { KwinAdapter } from "../record/input/kwin.js";
import type { ScreenInfo } from "../record/input/types.js";
import { run } from "../util/exec.js";
import { parseCombo, splitTyping, charKeysym } from "./keys.js";
import { type PortalStream, RemoteDesktopSession } from "./portal.js";
import { loadState, saveState } from "./state.js";

// The agent's hands: smooth pointer motion, clicks, keys and typing on the
// real desktop (KDE Wayland via the RemoteDesktop portal), with the pointer
// position and monitor layout read back from KWin.

/** A point on a monitor, normalized 0..1. Without `screen`, the monitor under the pointer. */
export interface Target {
  screen?: string;
  x: number;
  y: number;
}

export type Button = "left" | "right" | "middle";
const BTN: Record<Button, number> = { left: 0x110, right: 0x111, middle: 0x112 };

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
  /** Max distance (px) between where we put the pointer and where KWin sees it before we stop. */
  interruptPx?: number;
  seed?: number;
}

export class Driver {
  readonly actions: DriverAction[] = [];
  private pos = { x: 0, y: 0 };
  private rand: () => number;
  private aborted = false;

  private constructor(
    private portal: RemoteDesktopSession,
    private kwin: KwinAdapter,
    private streamOf: Map<string, PortalStream>,
    private opts: DriverOptions,
  ) {
    this.rand = rng(opts.seed ?? 7);
    const c = kwin.cursor();
    if (c) this.pos = { ...c };
  }

  static async open(opts: DriverOptions = {}): Promise<Driver> {
    const log = opts.log ?? (() => {});
    const kwin = new KwinAdapter();
    await kwin.start();
    const portal = new RemoteDesktopSession();
    const state = await loadState();
    try {
      if (!state.remoteDesktopToken) log("Allow remote control in the KDE dialog and select ALL monitors (asked once).");
      await portal.open(state.remoteDesktopToken);
    } catch (err) {
      await kwin.stop();
      throw err;
    }
    if (portal.restoreToken && portal.restoreToken !== state.remoteDesktopToken) {
      await saveState({ ...state, remoteDesktopToken: portal.restoreToken });
    }
    const streamOf = mapStreams(portal.streams, kwin.screens());
    const missing = kwin.screens().filter((s) => !streamOf.has(s.name));
    if (missing.length) log(`No control stream for ${missing.map((s) => s.name).join(", ")}; pointer can't reach it.`);
    return new Driver(portal, kwin, streamOf, opts);
  }

  screens(): ScreenInfo[] {
    return this.kwin.screens();
  }

  cursor(): { x: number; y: number } {
    return this.kwin.cursor() ?? this.pos;
  }

  /** Normalized monitor target → global logical pixels. */
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
    const code = BTN[opts.button ?? "left"];
    for (let i = 0; i < (opts.count ?? 1); i++) {
      this.checkInterrupted();
      await this.press(code, true);
      await sleep(45 + this.rand() * 30);
      await this.press(code, false);
      if (i + 1 < (opts.count ?? 1)) await sleep(70);
    }
  }

  async drag(from: Target, to: Target, opts: { dur?: number } = {}): Promise<void> {
    await this.moveTo(from);
    await this.press(BTN.left, true);
    await sleep(120);
    await this.moveTo(to, { dur: opts.dur ?? 0.8 });
    await sleep(80);
    await this.press(BTN.left, false);
  }

  /** Press at the current position, move to `to` (global px), release. */
  async dragTo(to: { x: number; y: number }, opts: { dur?: number } = {}): Promise<void> {
    await this.press(BTN.left, true);
    await sleep(120);
    await this.moveToGlobal(to, { dur: opts.dur ?? 0.8 });
    await sleep(80);
    await this.press(BTN.left, false);
  }

  /** Positive = down / right. */
  async scroll(steps: number, opts: { horizontal?: boolean; at?: Target } = {}): Promise<void> {
    if (opts.at) await this.moveTo(opts.at);
    const dir = Math.sign(steps);
    for (let i = 0; i < Math.abs(steps); i++) {
      this.checkInterrupted();
      await this.portal.axisDiscrete(opts.horizontal ? 1 : 0, dir);
      this.actions.push({ at: performance.now(), type: "scroll", px: this.pos.x, py: this.pos.y });
      await sleep(60);
    }
  }

  async key(combo: string): Promise<void> {
    this.checkInterrupted();
    const syms = parseCombo(combo);
    this.actions.push({ at: performance.now(), type: "key", px: this.pos.x, py: this.pos.y });
    for (const s of syms) {
      await this.portal.keysym(s, true);
      await sleep(15);
    }
    for (const s of [...syms].reverse()) {
      await this.portal.keysym(s, false);
      await sleep(15);
    }
  }

  /** Types like a person (~`cps` chars/s). Text outside Latin-1 (e.g. Arabic) goes through the clipboard. */
  async type(text: string, opts: { cps?: number } = {}): Promise<void> {
    const delay = 1000 / (opts.cps ?? 14);
    for (const run of splitTyping(text)) {
      if (!run.keys) {
        await this.paste(run.text);
        continue;
      }
      for (const ch of run.text) {
        this.checkInterrupted();
        const sym = charKeysym(ch)!;
        await this.portal.keysym(sym, true);
        await sleep(12);
        await this.portal.keysym(sym, false);
        await sleep(delay * (0.6 + this.rand() * 0.8));
      }
    }
  }

  async close(): Promise<void> {
    await this.portal.close();
    await this.kwin.stop();
  }

  private async paste(text: string): Promise<void> {
    let previous: string | undefined;
    try {
      previous = (await run("wl-paste", ["--no-newline"])).stdout;
    } catch {
      previous = undefined;
    }
    await writeClipboard(text);
    await sleep(80);
    await this.key("ctrl+v");
    await sleep(150);
    if (previous !== undefined) await writeClipboard(previous);
  }

  private screenAtCursor(): ScreenInfo | undefined {
    const c = this.cursor();
    return this.screens().find((s) => c.x >= s.x && c.x < s.x + s.w && c.y >= s.y && c.y < s.y + s.h) ?? this.screens()[0];
  }

  private async place(x: number, y: number): Promise<void> {
    const scr = this.screens().find((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
    const stream = scr && this.streamOf.get(scr.name);
    if (!scr || !stream) return; // gap between monitors: skip this step
    await this.portal.motionAbsolute(stream.node, ((x - scr.x) / scr.w) * stream.w, ((y - scr.y) / scr.h) * stream.h);
    this.pos = { x, y };
    this.actions.push({ at: performance.now(), type: "move", px: x, py: y });
  }

  private async press(code: number, down: boolean): Promise<void> {
    await this.portal.button(code, down);
    const button = code === BTN.left ? 1 : code === BTN.right ? 2 : 3;
    this.actions.push({ at: performance.now(), type: down ? "down" : "up", px: this.pos.x, py: this.pos.y, button });
  }

  /**
   * KWin reports the pointer a little after we move it, so compare what it
   * sees with every point we commanded recently, not just the last one.
   */
  private checkInterrupted(): void {
    if (this.aborted) throw new Error("Stopped (abort requested).");
    const seen = this.kwin.cursor();
    if (!seen || this.actions.length === 0) return;
    const limit = this.opts.interruptPx ?? 40;
    const since = performance.now() - 600;
    const recent = this.actions.filter((a) => a.type === "move" && a.at >= since);
    const points = recent.length ? recent.map((a) => ({ x: a.px, y: a.py })) : [this.pos];
    if (points.every((p) => Math.hypot(seen.x - p.x, seen.y - p.y) > limit)) throw new UserInterrupted();
  }
}

/** Match portal streams to KWin monitors: by position, else by size in layout order. */
export function mapStreams(streams: PortalStream[], screens: ScreenInfo[]): Map<string, PortalStream> {
  const out = new Map<string, PortalStream>();
  const free = [...streams];
  for (const s of screens) {
    const i = free.findIndex((st) => st.x === s.x && st.y === s.y && (st.w === 0 || st.w === s.w));
    if (i >= 0) out.set(s.name, free.splice(i, 1)[0]!);
  }
  const positioned = streams.some((st) => st.x !== 0 || st.y !== 0);
  if (!positioned) {
    for (const s of screens.filter((x) => !out.has(x.name))) {
      const i = free.findIndex((st) => st.w === s.w && st.h === s.h);
      if (i >= 0) out.set(s.name, free.splice(i, 1)[0]!);
    }
  }
  return out;
}

function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", () => resolve());
    child.stdin.end(text);
  });
}
