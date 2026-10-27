import { describe, expect, it } from "vitest";
import { WindowsInjector } from "../src/platform/windows/injector.js";
import type { Win32Input } from "../src/platform/windows/inputs.js";

// Primary at 0,0 and a shorter monitor to its left: (-100, 1200) is in the gap below it.
const screens = [
  { name: "\\\\.\\DISPLAY1", x: 0, y: 0, w: 2560, h: 1440 },
  { name: "\\\\.\\DISPLAY2", x: -1920, y: 0, w: 1920, h: 1080 },
];

function fake() {
  const sent: Win32Input[][] = [];
  const w = { sendInput: (i: Win32Input[]) => void sent.push(i), virtualScreen: () => ({ x: -1920, y: 0, w: 4480, h: 1440 }) };
  return { sent, inj: new WindowsInjector(w, screens) };
}

describe("WindowsInjector", () => {
  it("moves on monitors and refuses gaps between them", async () => {
    const { sent, inj } = fake();
    expect(await inj.moveTo(-1000, 500)).toBe(true);
    expect(await inj.moveTo(-100, 1200)).toBe(false);
    expect(await inj.moveTo(5000, 10)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("types one character per SendInput, checking before each and turning CRLF into one Enter", async () => {
    const { sent, inj } = fake();
    let checks = 0;
    await inj.typeText("a\r\n😀", { before: () => checks++, gap: () => 0 });
    expect(checks).toBe(3);
    expect(sent.map((s) => s.length)).toEqual([2, 2, 4]);
    expect(sent[1]![0]).toMatchObject({ u: { ki: { wVk: 0x0d } } });
  });

  it("stops typing when the check throws", async () => {
    const { sent, inj } = fake();
    let n = 0;
    const before = () => {
      if (++n === 2) throw new Error("interrupted");
    };
    await expect(inj.typeText("abc", { before, gap: () => 0 })).rejects.toThrow("interrupted");
    expect(sent).toHaveLength(1);
  });

  it("presses a combo key by key and releases in reverse", async () => {
    const { sent, inj } = fake();
    await inj.pressCombo("ctrl+shift+t");
    const ki = sent.map((s) => (s[0]!.type === 1 ? s[0]!.u.ki : undefined));
    expect(ki.map((k) => [k!.wVk, k!.dwFlags & 2 ? "up" : "down"])).toEqual([
      [0x11, "down"],
      [0x10, "down"],
      [0x54, "down"],
      [0x54, "up"],
      [0x10, "up"],
      [0x11, "up"],
    ]);
  });
});
