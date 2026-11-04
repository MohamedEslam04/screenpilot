import { describe, expect, it } from "vitest";
import { type AxElement, axRoleName, readAxNode } from "../src/a11y/ax.js";

function el(attrs: Record<string, string | boolean>, frame: { x: number; y: number; w: number; h: number } | undefined, kids: AxElement[] = [], onRelease?: () => void): AxElement {
  return {
    str: (a) => (typeof attrs[a] === "string" ? (attrs[a] as string) : undefined),
    bool: (a) => (typeof attrs[a] === "boolean" ? (attrs[a] as boolean) : undefined),
    frame: () => frame,
    children: () => kids,
    release: () => onRelease?.(),
  };
}

describe("axRoleName", () => {
  it("maps AX roles to AT-SPI names", () => {
    expect(axRoleName("AXButton")).toBe("push button");
    expect(axRoleName("AXTextField")).toBe("entry");
    expect(axRoleName("AXRadioButton", "AXTabButton")).toBe("page tab");
    expect(axRoleName("AXMenuItem")).toBe("menu item");
  });
  it("turns unknown AX roles into readable names", () => {
    expect(axRoleName("AXDisclosureTriangle")).toBe("disclosure triangle");
  });
});

describe("readAxNode", () => {
  it("reads role, name, states, frame and children, releasing children", () => {
    const released: string[] = [];
    const ok = el({ AXRole: "AXButton", AXTitle: "Save", AXEnabled: true, AXFocused: true }, { x: 10, y: 20, w: 80, h: 24 }, [], () => released.push("ok"));
    const text = el({ AXRole: "AXStaticText", AXValue: "Hello" }, { x: 0, y: 0, w: 40, h: 10 }, [], () => released.push("text"));
    const win = el({ AXRole: "AXWindow", AXTitle: "Doc" }, { x: 100, y: 100, w: 500, h: 400 }, [ok, text]);
    const budget = { count: 0, max: 100, truncated: false };
    const n = readAxNode(win, 0, 10, budget);
    expect(n).toMatchObject({ role: "frame", name: "Doc", rect: { x: 100, y: 100, w: 500, h: 400 } });
    expect(n.children[0]).toMatchObject({ role: "push button", name: "Save", rect: { x: 10, y: 20, w: 80, h: 24 } });
    expect(n.children[0]!.states).toEqual(["showing", "enabled", "focused"]);
    expect(n.children[1]).toMatchObject({ role: "label", name: "Hello" });
    expect(released.sort()).toEqual(["ok", "text"]);
  });

  it("marks disabled controls and stops at the depth and node budgets", () => {
    const leaf = el({ AXRole: "AXButton", AXTitle: "A", AXEnabled: false }, { x: 0, y: 0, w: 1, h: 1 });
    expect(readAxNode(leaf, 0, 5, { count: 0, max: 5, truncated: false }).states).toEqual(["showing"]);
    const deep = el({ AXRole: "AXGroup" }, undefined, [el({ AXRole: "AXButton", AXTitle: "B" }, { x: 0, y: 0, w: 1, h: 1 })]);
    const b = { count: 0, max: 100, truncated: false };
    expect(readAxNode(deep, 0, 0, b).children).toEqual([]);
    expect(b.truncated).toBe(true);
  });
});
