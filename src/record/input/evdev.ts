import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";

// Mouse buttons straight from the kernel (/dev/input/event*). On Wayland this
// is the only way to see clicks in other apps; it needs the `input` group.

const EV_KEY = 1;
const BUTTONS: Record<number, number> = { 0x110: 1, 0x111: 2, 0x112: 3 }; // BTN_LEFT/RIGHT/MIDDLE → 1/2/3
const EVENT_SIZE = 24; // struct input_event on 64-bit: timeval(16) + type(2) + code(2) + value(4)

export interface ButtonEvent {
  button: number;
  down: boolean;
}

/** Event device paths whose key bitmap includes BTN_LEFT. */
export function parseMouseDevices(procDevices: string): string[] {
  const out: string[] = [];
  for (const block of procDevices.split(/\n\s*\n/)) {
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1] ?? "";
    const event = /\b(event\d+)\b/.exec(handlers)?.[1];
    const keyBits = /^B: KEY=(.*)$/m.exec(block)?.[1];
    if (!event || !keyBits) continue;
    if (hasBit(keyBits.trim(), 0x110)) out.push(`/dev/input/${event}`);
  }
  return out;
}

/** /proc bitmaps are space-separated hex words, most significant first, word size = 64 bits. */
export function hasBit(bitmap: string, bit: number): boolean {
  const words = bitmap.split(/\s+/).reverse();
  const word = words[Math.floor(bit / 64)];
  if (!word) return false;
  return ((BigInt(`0x${word}`) >> BigInt(bit % 64)) & 1n) === 1n;
}

export function parseEvents(buf: Buffer): ButtonEvent[] {
  const out: ButtonEvent[] = [];
  for (let off = 0; off + EVENT_SIZE <= buf.length; off += EVENT_SIZE) {
    const type = buf.readUInt16LE(off + 16);
    const code = buf.readUInt16LE(off + 18);
    const value = buf.readInt32LE(off + 20);
    const button = BUTTONS[code];
    if (type === EV_KEY && button && value !== 2) out.push({ button, down: value === 1 });
  }
  return out;
}

export class EvdevButtons {
  private children: ChildProcess[] = [];
  readonly warnings: string[] = [];

  constructor(private onButton: (e: ButtonEvent) => void) {}

  /**
   * One `cat` per device: reads of character devices block, and doing them
   * through fs streams would pin libuv's small thread pool; pipes do not.
   */
  async start(): Promise<number> {
    const devices = parseMouseDevices(await readFile("/proc/bus/input/devices", "utf8"));
    const readable = devices.filter((d) => {
      try {
        accessSync(d, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    });
    for (const dev of readable) {
      const child = spawn("cat", [dev], { stdio: ["ignore", "pipe", "ignore"] });
      let pending = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const usable = pending.length - (pending.length % EVENT_SIZE);
        for (const e of parseEvents(pending.subarray(0, usable))) this.onButton(e);
        pending = pending.subarray(usable);
      });
      child.on("error", () => {});
      this.children.push(child);
    }
    if (readable.length === 0) {
      this.warnings.push(
        devices.length > 0
          ? "Clicks not recorded: no permission to read /dev/input. Run `sudo usermod -aG input $USER` and log in again (note: that group can read all keyboard input)."
          : "Clicks not recorded: no mouse devices found in /proc/bus/input/devices.",
      );
    }
    return readable.length;
  }

  stop(): void {
    for (const c of this.children) c.kill();
    this.children = [];
  }
}
