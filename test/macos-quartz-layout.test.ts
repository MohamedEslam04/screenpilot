import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { AX_GET_WINDOW, defineTypes, PROTOTYPES } from "../src/platform/macos/quartz.js";

// The frameworks only exist on macOS, but types and prototypes are pure
// declarations: koffi.proto uses the same parser as lib.func, so typos in
// names/types fail here, not on a Mac. CGFloat is double on 64-bit macOS.

describe("Quartz types and prototypes", () => {
  const t = defineTypes(koffi);

  it("lays CGPoint/CGSize/CGRect out as on 64-bit macOS", () => {
    expect(koffi.sizeof(t.CGPoint)).toBe(16);
    expect(koffi.sizeof(t.CGSize)).toBe(16);
    expect(koffi.sizeof(t.CGRect)).toBe(32);
    expect(koffi.offsetof(t.CGRect, "size")).toBe(16);
  });

  it("parses every function prototype against these types", () => {
    const protos = [...Object.values(PROTOTYPES).flatMap((p) => Object.values(p) as string[]), AX_GET_WINDOW];
    expect(protos.length).toBe(48);
    for (const p of protos) expect(() => koffi.proto(p.replace(/(\w+)\(/, "MacCheck_$1(")), p).not.toThrow();
  });
});
