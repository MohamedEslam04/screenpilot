import { screenAt, type Rect, type ScreenInfo } from "../../record/input/types.js";
import type { Injector, MouseButton } from "../types.js";
import { absoluteMove, buttonInput, charInputs, keyInput, parseComboVk, wheelInput } from "./inputs.js";
import type { Win32 } from "./win32.js";

// Synthetic input through SendInput. Text goes in as Unicode key events, so
// it needs no clipboard and does not depend on the keyboard layout.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WindowsInjector implements Injector {
  private virt: Rect;

  constructor(
    private w: Pick<Win32, "sendInput" | "virtualScreen">,
    private screens: ScreenInfo[],
  ) {
    this.virt = w.virtualScreen();
  }

  async moveTo(x: number, y: number): Promise<boolean> {
    // Windows clamps points in gaps between monitors; report them so the driver skips the step.
    const v = this.virt;
    const on = this.screens.length ? !!screenAt(this.screens, x, y) : x >= v.x && x < v.x + v.w && y >= v.y && y < v.y + v.h;
    if (!on) return false;
    this.w.sendInput([absoluteMove(x, y, v)]);
    return true;
  }

  async button(b: MouseButton, down: boolean): Promise<void> {
    this.w.sendInput([buttonInput(b, down)]);
  }

  async wheel(horizontal: boolean, step: 1 | -1): Promise<void> {
    this.w.sendInput([wheelInput(horizontal, step)]);
  }

  async pressCombo(combo: string): Promise<void> {
    const keys = parseComboVk(combo);
    for (const k of keys) {
      this.w.sendInput([keyInput(k, true)]);
      await sleep(15);
    }
    for (const k of [...keys].reverse()) {
      this.w.sendInput([keyInput(k, false)]);
      await sleep(15);
    }
  }

  async typeText(text: string, hooks: { before: () => void; gap: () => number }): Promise<void> {
    for (const ch of text.replace(/\r\n?/g, "\n")) {
      hooks.before();
      this.w.sendInput(charInputs(ch));
      await sleep(hooks.gap());
    }
  }

  async close(): Promise<void> {}
}
