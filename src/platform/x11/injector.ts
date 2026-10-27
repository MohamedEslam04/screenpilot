import { parseCombo } from "../../drive/keys.js";
import { screenAt, type ScreenInfo } from "../../record/input/types.js";
import type { Injector, MouseButton } from "../types.js";
import { findKeystroke, type Keymap, keysymForChar, NO_SYMBOL, spareKeycodes, XK_SHIFT_L } from "./keymap.js";
import type { XApi } from "./xlib.js";

// Synthetic input through XTest. Keys are found in the current keyboard
// mapping; a character no key produces (Arabic, emoji, ...) is typed by
// binding it to a spare keycode for a moment, as xdotool does, so no
// clipboard and no layout switch is needed.

const BUTTON: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** X wheel buttons: 4/5 = up/down, 6/7 = left/right. */
export function wheelButton(horizontal: boolean, step: 1 | -1): number {
  return horizontal ? (step > 0 ? 7 : 6) : step > 0 ? 5 : 4;
}

export class X11Injector implements Injector {
  private map?: Keymap;
  private spares: number[] = [];
  private nextSpare = 0;
  /** Spare keycode → keysym bound to it right now. */
  private bound = new Map<number, number>();

  constructor(
    private x: XApi,
    private screens: ScreenInfo[],
  ) {}

  async moveTo(x: number, y: number): Promise<boolean> {
    if (this.screens.length && !screenAt(this.screens, x, y)) return false; // gap between monitors
    this.x.fakeMotion(x, y);
    return true;
  }

  async button(b: MouseButton, down: boolean): Promise<void> {
    this.x.fakeButton(BUTTON[b], down);
  }

  async wheel(horizontal: boolean, step: 1 | -1): Promise<void> {
    const b = wheelButton(horizontal, step);
    this.x.fakeButton(b, true);
    this.x.fakeButton(b, false);
  }

  async pressCombo(combo: string): Promise<void> {
    const codes = parseCombo(combo).map((sym) => this.stroke(sym).code);
    for (const c of codes) {
      this.x.fakeKey(c, true);
      await sleep(15);
    }
    for (const c of [...codes].reverse()) {
      this.x.fakeKey(c, false);
      await sleep(15);
    }
  }

  async typeText(text: string, hooks: { before: () => void; gap: () => number }): Promise<void> {
    for (const ch of text.replace(/\r\n?/g, "\n")) {
      hooks.before();
      const { code, shift } = this.stroke(keysymForChar(ch));
      const shiftCode = shift ? this.stroke(XK_SHIFT_L).code : 0;
      if (shift) this.x.fakeKey(shiftCode, true);
      this.x.fakeKey(code, true);
      await sleep(12);
      this.x.fakeKey(code, false);
      if (shift) this.x.fakeKey(shiftCode, false);
      await sleep(hooks.gap());
    }
  }

  async close(): Promise<void> {
    // Unbind the spare keycodes we used.
    for (const code of this.bound.keys()) this.x.setKeysyms(code, new Array<number>(this.map?.per ?? 1).fill(NO_SYMBOL));
    this.bound.clear();
    this.x.sync();
  }

  /** Keycode (and Shift) for a keysym; binds a spare keycode when no key has it. */
  private stroke(sym: number): { code: number; shift: boolean } {
    this.map ??= this.x.keymap();
    const found = findKeystroke(this.map, sym, this.x.group());
    if (found) return found;
    for (const [code, s] of this.bound) if (s === sym) return { code, shift: false };
    if (!this.spares.length) this.spares = spareKeycodes(this.map);
    if (!this.spares.length) throw new Error(`No free keycode to type keysym 0x${sym.toString(16)}`);
    // Round robin: a code is rebound only after the others, so the app has long processed its last key.
    const code = this.spares[this.nextSpare++ % this.spares.length]!;
    this.x.setKeysyms(code, new Array<number>(this.map.per).fill(sym)); // every level: Shift/layout do not matter
    this.bound.set(code, sym); // the cached map keeps it as spare; `bound` is checked instead
    return { code, shift: false };
  }
}
