import { performance } from "node:perf_hooks";
import { screenAt, type ScreenInfo } from "../../record/input/types.js";
import type { Injector, MouseButton } from "../types.js";
import { buttonEvent, charEvents, ClickCounter, comboEvents, moveEvent, scrollEvent, type MacEvent } from "./events.js";

// Synthetic input through CGEventPost (HID level). Coordinates are global
// points. Text goes in as Unicode key events, so it needs no clipboard and
// does not depend on the keyboard layout.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PostApi {
  post(e: MacEvent): void;
  cursor(): { x: number; y: number };
}

export class MacInjector implements Injector {
  private pos?: { x: number; y: number };
  private held = new Set<MouseButton>();
  private clicks = new ClickCounter();
  private keysReady = false;

  constructor(
    private q: PostApi,
    private screens: ScreenInfo[],
    private now: () => number = () => performance.now(),
    /** Wait after the warm-up Shift tap (0 skips the warm-up, e.g. in tests). */
    private warmUpMs = 600,
  ) {}

  async moveTo(x: number, y: number): Promise<boolean> {
    // Quartz clamps points between displays to the nearest edge; report them so the driver skips the step.
    if (this.screens.length && !screenAt(this.screens, x, y)) return false;
    this.q.post(moveEvent(x, y, this.held));
    this.pos = { x, y };
    return true;
  }

  async button(b: MouseButton, down: boolean): Promise<void> {
    const p = this.pos ?? this.q.cursor();
    const state = down ? this.clicks.press(b, p.x, p.y, this.now()) : this.clicks.release(b);
    if (down) this.held.add(b);
    else this.held.delete(b);
    this.q.post(buttonEvent(b, down, p.x, p.y, state));
  }

  async wheel(horizontal: boolean, step: 1 | -1): Promise<void> {
    this.q.post(scrollEvent(horizontal, step));
  }

  /**
   * The first synthetic key events after we start are dropped on macOS (seen on
   * CI: the first typed text never arrives, the same text a moment later does).
   * A Shift tap and a short wait absorb that before anything that matters.
   */
  private async warmUpKeys(): Promise<void> {
    if (this.keysReady || this.warmUpMs <= 0) return;
    this.keysReady = true;
    for (const e of comboEvents("shift")) this.q.post(e);
    await sleep(this.warmUpMs);
  }

  async pressCombo(combo: string): Promise<void> {
    await this.warmUpKeys();
    for (const e of comboEvents(combo)) {
      this.q.post(e);
      await sleep(15);
    }
  }

  async typeText(text: string, hooks: { before: () => void; gap: () => number }): Promise<void> {
    await this.warmUpKeys();
    for (const ch of text.replace(/\r\n?/g, "\n")) {
      hooks.before();
      for (const e of charEvents(ch)) this.q.post(e);
      await sleep(hooks.gap());
    }
  }

  async close(): Promise<void> {
    // Never leave a button pressed (a take that failed mid-drag).
    const p = this.pos ?? this.q.cursor();
    for (const b of [...this.held]) this.q.post(buttonEvent(b, false, p.x, p.y, 1));
    this.held.clear();
  }
}
