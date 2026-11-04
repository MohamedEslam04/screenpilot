import { describe, expect, it } from "vitest";
import { buildUiaScript, parseUiaOutput, uiaRoleName } from "../src/a11y/uia.js";

describe("uiaRoleName", () => {
  it("maps UI Automation control types to AT-SPI names", () => {
    expect(uiaRoleName("ControlType.Button")).toBe("push button");
    expect(uiaRoleName("ControlType.Edit")).toBe("entry");
    expect(uiaRoleName("ControlType.TabItem")).toBe("page tab");
    expect(uiaRoleName("ControlType.Window")).toBe("frame");
    expect(uiaRoleName("ControlType.Hyperlink")).toBe("link");
  });
  it("turns unknown types into readable names", () => {
    expect(uiaRoleName("ControlType.AppBar")).toBe("app bar");
    expect(uiaRoleName("")).toBe("");
  });
});

describe("parseUiaOutput", () => {
  const out = JSON.stringify({
    truncated: false,
    nodes: [
      { i: 0, p: -1, t: "ControlType.Window", n: "Calculator", x: 100, y: 50, w: 400, h: 600, e: true, f: false, o: false, a: 4242, pn: "CalculatorApp" },
      { i: 1, p: 0, t: "ControlType.Group", n: "", x: 100, y: 80, w: 400, h: 570, e: true, f: false, o: false },
      { i: 2, p: 1, t: "ControlType.Button", n: "Five", x: 120, y: 300, w: 90, h: 60, e: true, f: true, o: false },
      { i: 3, p: 1, t: "ControlType.Button", n: "Hidden", x: 0, y: 0, w: 0, h: 0, e: false, f: false, o: true },
      { i: 4, p: -1, t: "ControlType.Window", n: "Other", x: 0, y: 0, w: 10, h: 10, e: true, f: false, o: false, a: 99, pn: "other" },
    ],
  });

  it("rebuilds windows and their trees from the flat list", () => {
    const wins = parseUiaOutput(out);
    expect(wins).toHaveLength(2);
    expect(wins[0]).toMatchObject({ app: "CalculatorApp", pid: 4242, title: "Calculator", rect: { x: 100, y: 50, w: 400, h: 600 }, truncated: false });
    const five = wins[0]!.root.children[0]!.children[0]!;
    expect(five).toMatchObject({ role: "push button", name: "Five", rect: { x: 120, y: 300, w: 90, h: 60 } });
    expect(five.states).toEqual(["showing", "enabled", "focused"]);
  });

  it("marks offscreen and disabled elements", () => {
    const hidden = parseUiaOutput(out)[0]!.root.children[0]!.children[1]!;
    expect(hidden.states).toEqual([]);
  });

  it("carries the truncated flag", () => {
    expect(parseUiaOutput(JSON.stringify({ truncated: true, nodes: JSON.parse(out).nodes }))[0]!.truncated).toBe(true);
  });

  it("throws a readable error on garbage", () => {
    expect(() => parseUiaOutput("not json")).toThrow(/UI Automation/);
  });

  it("returns no windows for an empty result", () => {
    expect(parseUiaOutput(JSON.stringify({ truncated: false, nodes: [] }))).toEqual([]);
  });
});

describe("buildUiaScript", () => {
  it("embeds the pids and limits without using the reserved $pid variable", () => {
    const s = buildUiaScript([12, 34], 15, 800);
    expect(s).toContain("@(12,34)");
    expect(s).toContain("$maxDepth = 15");
    expect(s).toContain("$maxNodes = 800");
    expect(s).not.toMatch(/\$pid\b/i);
  });
  it("only accepts integer pids", () => {
    expect(() => buildUiaScript([1.5 as number], 5, 5)).toThrow(/pid/);
  });
});
