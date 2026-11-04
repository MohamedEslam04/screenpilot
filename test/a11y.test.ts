import { describe, expect, it } from "vitest";
import { decodeStates } from "../src/a11y/atspi.js";
import { appPids, findMatches, flatten, pickMatch, placeWindows, pruneTree, roleMatches } from "../src/a11y/locate.js";
import type { RawNode, RawWindow } from "../src/a11y/types.js";
import { TargetError } from "../src/drive/errors.js";
import type { WindowInfo } from "../src/platform/types.js";

const OFFSCREEN = -2147483648;

const node = (role: string, name: string, rect: [number, number, number, number] | null, children: RawNode[] = [], states = ["showing", "enabled"]): RawNode => ({
  role,
  name,
  rect: rect && { x: rect[0], y: rect[1], w: rect[2], h: rect[3] },
  states,
  children,
});

// KCalc as seen on KDE Wayland: extents are relative to the window.
const calc: RawWindow = {
  app: "kcalc",
  pid: 100,
  title: "KCalc",
  rect: { x: 0, y: 0, w: 640, h: 480 },
  truncated: false,
  root: node("frame", "KCalc", [0, 0, 640, 480], [
    node("filler", "", [0, 0, 640, 480], [
      node("push button", "Five", [112, 282, 100, 52]),
      node("push button", "Six", [216, 282, 99, 52]),
      node("push button", "Hidden", [0, 0, 0, 0]),
      node("push button", "Five", [112, 400, 100, 52], [], ["enabled"]), // not showing
      node("menu item", "Quit", [OFFSCREEN, OFFSCREEN, 1, 1]),
    ]),
  ]),
};

const win = (o: Partial<WindowInfo>): WindowInfo => ({
  id: "1",
  caption: "KCalc",
  resourceClass: "org.kde.kcalc",
  pid: 100,
  active: false,
  minimized: false,
  x: 640,
  y: 340,
  w: 640,
  h: 480,
  output: "HDMI-A-5",
  ...o,
});

describe("roleMatches", () => {
  it("matches AT-SPI names ignoring case and separators", () => {
    expect(roleMatches("push button", "push button")).toBe(true);
    expect(roleMatches("Push_Button", "push button")).toBe(true);
    expect(roleMatches("check-box", "check box")).toBe(true);
  });
  it("knows friendly aliases", () => {
    expect(roleMatches("button", "push button")).toBe(true);
    expect(roleMatches("button", "toggle button")).toBe(true);
    expect(roleMatches("checkbox", "check box")).toBe(true);
    expect(roleMatches("textbox", "entry")).toBe(true);
    expect(roleMatches("menuitem", "check menu item")).toBe(true);
    expect(roleMatches("button", "menu item")).toBe(false);
  });
});

describe("placeWindows", () => {
  it("adds the desktop window origin when extents are window-relative", () => {
    const [p] = placeWindows([calc], [win({})], false);
    expect(p!.placed).toBe(true);
    const five = flatten(p!).find((n) => n.name === "Five")!;
    expect([five.x, five.y, five.w, five.h]).toEqual([752, 622, 100, 52]);
  });

  it("leaves already-global extents alone", () => {
    const global: RawWindow = { ...calc, rect: { x: 640, y: 340, w: 640, h: 480 }, root: node("frame", "KCalc", [640, 340, 640, 480], [node("push button", "Five", [752, 622, 100, 52])]) };
    const [p] = placeWindows([global], [win({})], false);
    const five = flatten(p!).find((n) => n.name === "Five")!;
    expect([five.x, five.y]).toEqual([752, 622]);
  });

  it("picks the window by pid and title when an app has several", () => {
    const other = win({ id: "2", caption: "Other", x: 10, y: 20, w: 300, h: 200 });
    const [p] = placeWindows([calc], [other, win({})], false);
    expect(p!.window?.id).toBe("1");
  });

  it("matches by size when titles differ", () => {
    const a = win({ id: "a", caption: "KCalc — Scientific", x: 100, y: 100, w: 800, h: 600 });
    const b = win({ id: "b", caption: "KCalc — Basic", x: 640, y: 340 });
    const [p] = placeWindows([{ ...calc, title: "Something else" }], [a, b], false);
    expect(p!.window?.id).toBe("b");
  });

  it("marks windows with no desktop match as not placed (Wayland without window list)", () => {
    const [p] = placeWindows([calc], [], false);
    expect(p!.placed).toBe(false);
    expect(flatten(p!).find((n) => n.name === "Five")!.x).toBe(112);
  });

  it("trusts global extents on X11 even without a window match", () => {
    const [p] = placeWindows([calc], [], true);
    expect(p!.placed).toBe(true);
  });
});

describe("findMatches", () => {
  const placed = placeWindows([calc], [win({})], false);

  it("finds visible elements by role and name", () => {
    const m = findMatches(placed, { role: "button", name: "five" });
    expect(m).toHaveLength(1); // the copy that is not showing is skipped
    expect(m[0]).toMatchObject({ role: "push button", name: "Five", x: 752, y: 622, cx: 802, cy: 648, app: "kcalc" });
  });

  it("skips zero-size and offscreen elements", () => {
    expect(findMatches(placed, { name: "Hidden" })).toHaveLength(0);
    expect(findMatches(placed, { name: "Quit" })).toHaveLength(0);
  });

  it("matches names exactly on request", () => {
    expect(findMatches(placed, { name: "Fi", exact: true })).toHaveLength(0);
    expect(findMatches(placed, { name: "Fi" })).toHaveLength(1);
  });

  it("needs a role or a name", () => {
    expect(() => findMatches(placed, {})).toThrow(/role or a name/);
  });
});

describe("pickMatch", () => {
  const placed = placeWindows([calc], [win({})], false);
  const buttons = findMatches(placed, { role: "button" });

  it("returns the only match", () => {
    expect(pickMatch(findMatches(placed, { name: "Six" }), { name: "Six" }).name).toBe("Six");
  });

  it("refuses to guess between several matches and lists candidates", () => {
    try {
      pickMatch(buttons, { role: "button" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TargetError);
      expect((e as TargetError).code).toBe("AMBIGUOUS_TARGET");
      expect((e as TargetError).candidates).toHaveLength(2);
      expect((e as TargetError).candidates[0]).toMatch(/push button "Five"/);
    }
  });

  it("takes the nth match when asked", () => {
    expect(pickMatch(buttons, { role: "button", nth: 2 }).name).toBe("Six");
    expect(() => pickMatch(buttons, { role: "button", nth: 5 })).toThrow(/only 2/);
  });

  it("reports a missing element with a hint", () => {
    try {
      pickMatch([], { role: "button", name: "Nope" });
      expect.unreachable();
    } catch (e) {
      expect((e as TargetError).code).toBe("ELEMENT_NOT_FOUND");
      expect((e as TargetError).message).toMatch(/Nope/);
    }
  });

  it("collapses duplicates with the same role, name and rectangle", () => {
    const dup = [buttons[0]!, { ...buttons[0]! }];
    expect(pickMatch(dup, { name: "Five" }).name).toBe("Five");
  });
});

describe("pruneTree", () => {
  it("keeps interactive elements and the containers that lead to them", () => {
    const [p] = placeWindows([calc], [win({})], false);
    const pruned = pruneTree(p!.root, true);
    const names = flatten({ ...p!, root: pruned }).map((n) => n.name);
    expect(names).toContain("Five");
    expect(names).not.toContain("Hidden");
    expect(names).not.toContain("Quit");
  });

  it("drops invisible subtrees even when not pruning to interactive", () => {
    const [p] = placeWindows([calc], [win({})], false);
    const pruned = pruneTree(p!.root, false);
    expect(flatten({ ...p!, root: pruned }).map((n) => n.name)).not.toContain("Hidden");
  });
});

describe("appPids", () => {
  it("collects pids of desktop windows whose class or title contains the app", () => {
    const wins = [win({ pid: 5, resourceClass: "org.kde.kcalc" }), win({ pid: 6, resourceClass: "brave-browser", caption: "x" }), win({ pid: 7, caption: "Notes - KCalc fan" })];
    expect(appPids(wins, "kcalc")).toEqual([5, 7]);
  });
});

describe("decodeStates", () => {
  it("reads the AT-SPI state bitfield", () => {
    // SHOWING = bit 25, ENABLED = bit 8, FOCUSED = bit 12
    const word = (1 << 25) | (1 << 8) | (1 << 12);
    expect(decodeStates([word >>> 0, 0]).sort()).toEqual(["enabled", "focused", "showing"]);
  });
});
