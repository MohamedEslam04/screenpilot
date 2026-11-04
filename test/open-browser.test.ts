import { describe, expect, it } from "vitest";
import { browserCandidates, browserStartTimeout, waitUntil } from "../src/drive/web.js";
import { openCommand } from "../src/take/open.js";

describe("openCommand", () => {
  it("picks the default-app launcher per platform", () => {
    expect(openCommand("/a/b.pdf", "linux")).toEqual({ cmd: "xdg-open", args: ["/a/b.pdf"] });
    expect(openCommand("https://x.dev", "darwin")).toEqual({ cmd: "open", args: ["https://x.dev"] });
    expect(openCommand("C:\\a\\b.pdf", "win32")).toEqual({ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "C:\\a\\b.pdf"] });
    expect(openCommand("https://x.dev/?a=1&b=2", "win32").args[1]).toBe("https://x.dev/?a=1&b=2");
  });
});

describe("browserCandidates", () => {
  it("scans PATH on Linux with the posix delimiter", () => {
    const c = browserCandidates({ PATH: "/usr/bin:/opt/bin" }, "linux");
    expect(c[0]).toBe("/usr/bin/google-chrome");
    expect(c).toContain("/opt/bin/chromium");
  });

  it("lists Chrome, Edge, Brave under each Windows root, in order", () => {
    const c = browserCandidates({ ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\L" }, "win32");
    expect(c).toEqual([
      "C:\\PF\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\PF86\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\L\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\L\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\PF\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\PF86\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\L\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ]);
  });

  it("lists app bundles in /Applications then ~/Applications on macOS", () => {
    const c = browserCandidates({ HOME: "/Users/me", PATH: "/usr/bin" }, "darwin");
    expect(c.slice(0, 2)).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(c).toContain("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    expect(c).toContain("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    expect(browserCandidates({}, "darwin")).toHaveLength(4);
  });

  it("skips Windows roots that are not set", () => {
    expect(browserCandidates({ LOCALAPPDATA: "C:\\L" }, "win32")).toHaveLength(3);
  });
});

describe("waitUntil", () => {
  it("returns as soon as the check passes, without sleeping again", async () => {
    let calls = 0;
    const slept: number[] = [];
    const ok = await waitUntil(async () => ++calls === 3, { timeoutMs: 10_000, intervalMs: 250, sleep: async (ms) => void slept.push(ms) });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toEqual([250, 250]);
  });

  it("gives up after the timeout, having asked once more at the end", async () => {
    let calls = 0;
    const ok = await waitUntil(async () => (calls++, false), { timeoutMs: 1000, intervalMs: 250, sleep: async () => {} });
    expect(ok).toBe(false);
    expect(calls).toBe(5);
  });

  it("passes when the check passes on the very last try", async () => {
    let calls = 0;
    expect(await waitUntil(async () => ++calls === 5, { timeoutMs: 1000, intervalMs: 250, sleep: async () => {} })).toBe(true);
  });
});

describe("browserStartTimeout", () => {
  it("allows a cold start on a slow machine 45 s, and macOS (Gatekeeper check) a minute", () => {
    expect(browserStartTimeout("linux", false)).toBe(45_000);
    expect(browserStartTimeout("win32", false)).toBe(45_000);
    expect(browserStartTimeout("darwin", true)).toBe(60_000);
  });
});
