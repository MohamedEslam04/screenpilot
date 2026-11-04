import { describe, expect, it } from "vitest";
import { a11yFind, a11yFindAll, a11yTree, a11yWait, launchEnv } from "../src/a11y/index.js";
import { parseA11yTarget } from "../src/a11y/parse.js";
import type { A11ySource, RawNode, RawWindow } from "../src/a11y/types.js";
import { TargetError } from "../src/drive/errors.js";
import type { WindowInfo } from "../src/platform/types.js";

const btn = (name: string, x: number): RawNode => ({ role: "push button", name, rect: { x, y: 10, w: 50, h: 20 }, states: ["showing"], children: [] });
const raw = (app: string, pid: number, kids: RawNode[]): RawWindow => ({
  app,
  pid,
  title: app,
  rect: { x: 0, y: 0, w: 400, h: 300 },
  truncated: false,
  root: { role: "frame", name: app, rect: { x: 0, y: 0, w: 400, h: 300 }, states: ["showing"], children: kids },
});

const win = (o: Partial<WindowInfo>): WindowInfo => ({ id: "1", caption: "calc", resourceClass: "calc", pid: 7, active: true, minimized: false, x: 100, y: 200, w: 400, h: 300, output: "eDP-1", ...o });

function fake(windows: RawWindow[]): A11ySource & { seen: unknown[] } {
  const seen: unknown[] = [];
  return { id: "fake", seen, status: async () => ({ ok: true, detail: "fake" }), windows: async (o) => (seen.push(o), { windows, warnings: [] }) };
}

const desktop = (windows: WindowInfo[], windowControl = true) => ({ id: "kde" as const, windowControl, listWindows: async () => windows });

describe("a11yFind", () => {
  it("returns global pixels for one element", async () => {
    const m = await a11yFind(desktop([win({})]), { role: "button", name: "ok" }, fake([raw("calc", 7, [btn("OK", 20), btn("Cancel", 80)])]));
    expect(m).toMatchObject({ name: "OK", x: 120, y: 210, cx: 145, cy: 220 });
  });

  it("scopes to the focused window's app when no app is given", async () => {
    const src = fake([raw("calc", 7, [btn("OK", 20)])]);
    await a11yFind(desktop([win({})]), { name: "ok" }, src);
    expect(src.seen[0]).toMatchObject({ pids: [7] });
  });

  it("scopes by app name and the pids of its windows", async () => {
    const src = fake([raw("calc", 7, [btn("OK", 20)])]);
    await a11yFind(desktop([win({ active: false })]), { app: "calc", name: "ok" }, src);
    expect(src.seen[0]).toMatchObject({ app: "calc", pids: [7] });
  });

  it("looks at every app when the desktop cannot tell the focused one", async () => {
    const src = fake([raw("calc", 7, [btn("OK", 20)])]);
    await a11yFind(desktop([], false), { name: "ok" }, src).catch(() => undefined);
    expect(src.seen[0]).not.toHaveProperty("pids");
  });

  it("reports an unknown app with the Qt hint", async () => {
    await expect(a11yFind(desktop([win({})]), { app: "nope", name: "x" }, fake([]))).rejects.toMatchObject({ code: "APP_NOT_FOUND", message: expect.stringContaining("QT_LINUX_ACCESSIBILITY_ALWAYS_ON") });
  });

  it("refuses to guess between buttons", async () => {
    await expect(a11yFind(desktop([win({})]), { role: "button" }, fake([raw("calc", 7, [btn("OK", 20), btn("Cancel", 80)])]))).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET" });
  });

  it("skips windows that are minimized", async () => {
    const e = await a11yFind(desktop([win({ minimized: true })]), { name: "ok" }, fake([raw("calc", 7, [btn("OK", 20)])])).catch((x) => x);
    expect(e).toBeInstanceOf(TargetError);
    expect(e.code).toBe("ELEMENT_NOT_FOUND");
  });

  it("says when the OS has no accessibility source", async () => {
    await expect(a11yFind({ id: "windows", windowControl: true, listWindows: async () => [] }, { name: "x" })).rejects.toMatchObject({ code: "A11Y_UNAVAILABLE" });
  });

  it("turns a failing source into A11Y_UNAVAILABLE", async () => {
    const broken: A11ySource = { id: "b", status: async () => ({ ok: false, detail: "" }), windows: async () => Promise.reject(new Error("no bus")) };
    await expect(a11yFind(desktop([win({})]), { name: "x" }, broken)).rejects.toMatchObject({ code: "A11Y_UNAVAILABLE", message: expect.stringContaining("no bus") });
  });
});

describe("a11yFindAll", () => {
  it("lists every match", async () => {
    const all = await a11yFindAll(desktop([win({})]), { role: "button" }, fake([raw("calc", 7, [btn("OK", 20), btn("Cancel", 80)])]));
    expect(all.map((m) => m.name)).toEqual(["OK", "Cancel"]);
  });
});

describe("a11yTree", () => {
  it("returns the pruned tree in global pixels", async () => {
    const t = await a11yTree(desktop([win({})]), {}, fake([raw("calc", 7, [btn("OK", 20)])]));
    expect(t.windows[0]!.root.children[0]).toMatchObject({ name: "OK", x: 120, y: 210 });
  });
});

describe("a11yWait", () => {
  it("returns once the element appears", async () => {
    let calls = 0;
    const src: A11ySource = { id: "f", status: async () => ({ ok: true, detail: "" }), windows: async () => ({ windows: ++calls < 2 ? [raw("calc", 7, [])] : [raw("calc", 7, [btn("OK", 20)])], warnings: [] }) };
    const m = await a11yWait(desktop([win({})]), { name: "ok" }, 5000, src);
    expect(m.name).toBe("OK");
    expect(calls).toBe(2);
  });

  it("times out with a coded error", async () => {
    await expect(a11yWait(desktop([win({})]), { name: "ok" }, 50, fake([raw("calc", 7, [])]))).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("launchEnv", () => {
  it("turns Qt accessibility on for launched apps without overriding the user's choice", () => {
    expect(launchEnv({})).toMatchObject({ QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1", QT_ACCESSIBILITY: "1" });
    expect(launchEnv({ QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "0" }).QT_LINUX_ACCESSIBILITY_ALWAYS_ON).toBe("0");
  });
});

describe("parseA11yTarget", () => {
  it("splits role and name at the first colon", () => {
    expect(parseA11yTarget("button:Save")).toEqual({ role: "button", name: "Save" });
    expect(parseA11yTarget("link:http://x.test")).toEqual({ role: "link", name: "http://x.test" });
  });
  it("accepts a name alone or a role alone", () => {
    expect(parseA11yTarget("Save")).toEqual({ name: "Save" });
    expect(parseA11yTarget(":Save")).toEqual({ name: "Save" });
    expect(parseA11yTarget("button:")).toEqual({ role: "button" });
    expect(() => parseA11yTarget(":")).toThrow(/role and\/or a name/);
  });
});

describe("take schema", () => {
  it("accepts a11y targets and waits, and rejects empty queries", async () => {
    const { TargetSchema, StepSchema } = await import("../src/take/schema.js");
    expect(TargetSchema.safeParse({ a11y: { role: "button", name: "Save" } }).success).toBe(true);
    expect(TargetSchema.safeParse({ a11y: {} }).success).toBe(false);
    expect(TargetSchema.safeParse({ a11y: { name: "x", bogus: 1 } }).success).toBe(false);
    expect(StepSchema.safeParse({ click: { a11y: { name: "Save", nth: 2 } } }).success).toBe(true);
    expect(StepSchema.safeParse({ waitFor: { a11y: { role: "button", name: "Done" }, timeout: 5 } }).success).toBe(true);
    expect(StepSchema.safeParse({ waitFor: { web: "text=Done" } }).success).toBe(true);
  });
});
