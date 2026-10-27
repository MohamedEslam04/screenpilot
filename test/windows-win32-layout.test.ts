import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { charInputs, comboInputs, wheelInput, absoluteMove } from "../src/platform/windows/inputs.js";
import { assertLayout, defineTypes, PROTOTYPES } from "../src/platform/windows/win32.js";

// Struct layouts are pure type definitions, so they can be checked here with
// the Linux build of koffi (x64 Linux and x64 Windows agree on these sizes:
// every field is a fixed-width integer or a pointer-sized ULONG_PTR).

describe("Win32 struct layout (x64)", () => {
  const t = defineTypes(koffi);

  it("matches the Windows SDK sizes", () => {
    expect(koffi.sizeof(t.MOUSEINPUT)).toBe(32);
    expect(koffi.sizeof(t.KEYBDINPUT)).toBe(24);
    expect(koffi.sizeof(t.HARDWAREINPUT)).toBe(8);
    expect(koffi.sizeof(t.INPUT)).toBe(40);
    expect(koffi.offsetof(t.INPUT, "u")).toBe(8);
    expect(koffi.sizeof(t.RECT)).toBe(16);
    expect(koffi.sizeof(t.POINT)).toBe(8);
    expect(koffi.sizeof(t.MONITORINFOEXW)).toBe(104);
    expect(koffi.sizeof(t.DISPLAY_DEVICEW)).toBe(840);
    expect(koffi.sizeof(t.WINDOWPLACEMENT)).toBe(44);
    expect(() => assertLayout(koffi, t)).not.toThrow();
  });

  it("parses every function prototype against these types", () => {
    // koffi.proto uses the same parser as lib.func, so typos in names/types fail here, not on Windows.
    const protos = Object.values(PROTOTYPES).flatMap((p) => Object.values(p) as string[]);
    expect(protos.length).toBe(33);
    for (const p of protos) expect(() => koffi.proto(p.replace(/(\w+)\(/, "Check_$1(")), p).not.toThrow();
  });

  it("encodes our input descriptors byte-exactly", () => {
    const buf = Buffer.alloc(koffi.sizeof(t.INPUT));
    const at = (input: unknown) => {
      buf.fill(0xaa);
      koffi.encode(buf, 0, t.INPUT, input);
      return buf;
    };

    // Unicode key-down for U+0645: type=1, wVk=0, wScan=0x645, dwFlags=KEYEVENTF_UNICODE.
    let b = at(charInputs("م")[0]);
    expect(b.readUInt32LE(0)).toBe(1);
    expect(b.readUInt16LE(8)).toBe(0);
    expect(b.readUInt16LE(10)).toBe(0x645);
    expect(b.readUInt32LE(12)).toBe(0x4);

    // Extended key-up (End): wVk=0x23, flags EXTENDEDKEY|KEYUP.
    b = at(comboInputs("end")[1]);
    expect(b.readUInt16LE(8)).toBe(0x23);
    expect(b.readUInt32LE(12)).toBe(0x3);

    // Wheel down: mouseData must hold -120 as a DWORD, not a clamped 0.
    b = at(wheelInput(false, 1));
    expect(b.readUInt32LE(0)).toBe(0);
    expect(b.readInt32LE(16)).toBe(-120);
    expect(b.readUInt32LE(20)).toBe(0x0800);

    // Absolute move: dx/dy are LONGs at offsets 8/12.
    b = at(absoluteMove(-1920, 1439, { x: -1920, y: 0, w: 4480, h: 1440 }));
    expect(b.readInt32LE(8)).toBe(0);
    expect(b.readInt32LE(12)).toBe(65535);
    expect(b.readUInt32LE(20)).toBe(0xc001);
  });
});
