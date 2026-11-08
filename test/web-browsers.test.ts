import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { beforeAll, describe, expect, it } from "vitest";
import { configDir } from "../src/brand.js";
import { browserProfileDir, CDP_PORT, cdpPortFor, DemoBrowser, demoBrowser, launchArgs } from "../src/drive/web.js";
import type { Desktop, WindowInfo } from "../src/platform/types.js";
import { StepSchema, TargetSchema } from "../src/take/schema.js";

beforeAll(() => {
  // Never touch the real config folder (configDir may migrate an old one).
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sp-browsers-"));
});

describe("cdpPortFor", () => {
  it("gives main 9333, the first new id 9334, and the same port when asked again", () => {
    expect(cdpPortFor("main")).toBe(9333);
    expect(cdpPortFor("user")).toBe(9334);
    expect(cdpPortFor("user")).toBe(9334);
    expect(cdpPortFor("main")).toBe(9333);
    expect(cdpPortFor("admin")).toBe(9335);
    expect(CDP_PORT).toBe(9333);
  });
});

describe("browserProfileDir", () => {
  it("keeps today's profile for main and a separate one per other id", () => {
    expect(browserProfileDir("main")).toBe(join(configDir(), "browser"));
    expect(browserProfileDir("user")).toBe(join(configDir(), "browser-user"));
  });
});

describe("launchArgs", () => {
  it("reproduces today's main browser flags", () => {
    const args = launchArgs({ profile: "/p/browser", port: 9333, url: "https://x.test" });
    expect(args).toEqual([
      "--user-data-dir=/p/browser",
      "--remote-debugging-port=9333",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--new-window",
      "https://x.test",
    ]);
  });

  it("uses the second browser's own port and profile, as an app window", () => {
    const args = launchArgs({ profile: "/p/browser-user", port: 9334, app: true });
    expect(args).toContain("--user-data-dir=/p/browser-user");
    expect(args).toContain("--remote-debugging-port=9334");
    expect(args.at(-1)).toBe("--app=about:blank");
  });
});

const win = (o: Partial<WindowInfo>): WindowInfo => ({
  id: "w",
  caption: "",
  resourceClass: "brave-browser",
  pid: 1,
  active: false,
  minimized: false,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  output: "eDP-1",
  ...o,
});

/** A connected browser whose process id is `pid`, counting CDP sessions. */
function fakeBrowser(pid: number) {
  const calls = { sessions: 0 };
  const browser = {
    isConnected: () => true,
    newBrowserCDPSession: async () => {
      calls.sessions++;
      return { send: async () => ({ processInfo: [{ type: "renderer", id: 1 }, { type: "browser", id: pid }] }), detach: async () => {} };
    },
  } as unknown as Browser;
  return { browser, calls };
}

function fakeDesktop(windows: WindowInfo[]) {
  const calls = { list: 0 };
  const desktop = {
    id: "kde",
    windowControl: true,
    listWindows: async () => {
      calls.list++;
      return windows;
    },
  } as unknown as Desktop;
  return { desktop, calls };
}

describe("DemoBrowser", () => {
  it("main is the default instance with today's port, address and profile", () => {
    const main = demoBrowser();
    expect(main).toBe(demoBrowser("main"));
    expect(main.id).toBe("main");
    expect(main.port).toBe(9333);
    expect(main.cdpUrl).toBe("http://127.0.0.1:9333");
    expect(main.profile).toBe(join(configDir(), "browser"));
  });

  it("gives another id its own instance, port and profile", () => {
    const user = demoBrowser("user");
    expect(user).not.toBe(demoBrowser());
    expect(user).toBe(demoBrowser("user"));
    expect(user.port).toBe(9334);
    expect(user.profile).toBe(join(configDir(), "browser-user"));
  });

  it("rejects an id that is not a plain name (it becomes a folder name)", () => {
    expect(() => new DemoBrowser("../x")).toThrow(/browser id/);
  });

  it("finds its own window by process id, connecting to its own port", async () => {
    const urls: string[] = [];
    const { browser } = fakeBrowser(42);
    const { desktop } = fakeDesktop([win({ id: "main-win", pid: 41 }), win({ id: "user-win", pid: 42 })]);
    const b = new DemoBrowser("user", {
      connect: async (url) => {
        urls.push(url);
        return browser;
      },
      desktop: async () => desktop,
    });
    expect((await b.window()).id).toBe("user-win");
    expect(urls).toEqual(["http://127.0.0.1:9334"]);
  });

  it("asks CDP for the process id once, and lists windows fresh unless a recent one is allowed", async () => {
    const fb = fakeBrowser(7);
    const fd = fakeDesktop([win({ id: "a", pid: 7 })]);
    const b = new DemoBrowser("main", { connect: async () => fb.browser, desktop: async () => fd.desktop });
    await b.window();
    await b.window();
    expect(fd.calls.list).toBe(2);
    await b.window({ maxAgeMs: 10_000 });
    await b.window({ maxAgeMs: 10_000 });
    expect(fd.calls.list).toBe(2);
    b.forgetWindow();
    await b.window({ maxAgeMs: 10_000 });
    expect(fd.calls.list).toBe(3);
    expect(fb.calls.sessions).toBe(1);
  });
});

describe("stepBrowsers", () => {
  const ids = async (raw: unknown) => {
    const { stepBrowsers } = await import("../src/take/perform.js");
    return stepBrowsers(StepSchema.parse(raw));
  };

  it("defaults every web step to main, as before browser ids", async () => {
    expect(await ids({ browser: { url: "https://x.test" } })).toEqual(["main"]);
    expect(await ids({ goto: "https://x.test" })).toEqual(["main"]);
    expect(await ids({ click: { web: "#save" } })).toEqual(["main"]);
    expect(await ids({ waitFor: { web: "text=Saved" } })).toEqual(["main"]);
    expect(await ids({ highlight: { web: "[data-toast]" } })).toEqual(["main"]);
    expect(await ids({ focus: { browser: true } })).toEqual(["main"]);
  });

  it("reads the browser id of every kind of step", async () => {
    expect(await ids({ browser: { id: "user" } })).toEqual(["user"]);
    expect(await ids({ goto: "https://x.test", browser: "user" })).toEqual(["user"]);
    expect(await ids({ drag: { from: { web: "#a" }, to: { web: "#b", browser: "user" } } })).toEqual(["main", "user"]);
    expect(await ids({ waitFor: { web: "text=Saved", browser: "user" } })).toEqual(["user"]);
    expect(await ids({ highlight: { web: "[data-toast]", browser: "user" } })).toEqual(["user"]);
    expect(await ids({ focus: { browser: "user" } })).toEqual(["user"]);
    expect(await ids({ tile: { browsers: ["main", "user"] } })).toEqual(["main", "user"]);
  });

  it("finds no browser in non-web steps", async () => {
    expect(await ids({ click: { screen: "eDP-1", x: 0.5, y: 0.5 } })).toEqual([]);
    expect(await ids({ focus: { match: "konsole" } })).toEqual([]);
    expect(await ids({ key: "enter" })).toEqual([]);
  });
});

describe("browser ids in the take schema", () => {
  it("accepts a {web} target in another browser", () => {
    expect(TargetSchema.safeParse({ web: "main", browser: "user" }).success).toBe(true);
    expect(TargetSchema.safeParse({ web: "#save" }).success).toBe(true);
    expect(TargetSchema.safeParse({ web: "#save", browser: "../x" }).success).toBe(false);
  });

  it("accepts a browser id on browser, goto, waitFor and highlight steps", () => {
    expect(StepSchema.safeParse({ browser: { id: "user", url: "https://x.test" } }).success).toBe(true);
    expect(StepSchema.safeParse({ goto: "https://x.test", browser: "user" }).success).toBe(true);
    expect(StepSchema.safeParse({ waitFor: { web: "text=Saved", browser: "user", timeout: 5 } }).success).toBe(true);
    expect(StepSchema.safeParse({ highlight: { web: "[data-toast]", browser: "user" } }).success).toBe(true);
    expect(StepSchema.safeParse({ click: { web: "#save", browser: "user" } }).success).toBe(true);
  });

  it("focuses a browser by id, or the main one with true", () => {
    expect(StepSchema.safeParse({ focus: { browser: "user" } }).success).toBe(true);
    expect(StepSchema.safeParse({ focus: { browser: true } }).success).toBe(true);
    expect(StepSchema.safeParse({ focus: { browser: false } }).success).toBe(false);
    expect(StepSchema.safeParse({ focus: { browser: "user", match: "x" } }).success).toBe(false);
  });

  it("parses a tile step and needs at least one browser", () => {
    expect(StepSchema.safeParse({ tile: { browsers: ["main", "user"] } }).success).toBe(true);
    expect(StepSchema.safeParse({ tile: { screen: "eDP-1", browsers: ["main", "user"] } }).success).toBe(true);
    expect(StepSchema.safeParse({ tile: { browsers: [] } }).success).toBe(false);
  });
});
