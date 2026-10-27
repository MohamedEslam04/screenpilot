import { describe, expect, it } from "vitest";
import { browserCandidates } from "../src/drive/web.js";
import { openCommand } from "../src/take/open.js";

describe("openCommand", () => {
  it("picks the default-app launcher per platform", () => {
    expect(openCommand("/a/b.pdf", "linux")).toEqual({ cmd: "xdg-open", args: ["/a/b.pdf"] });
    expect(openCommand("https://x.dev", "darwin")).toEqual({ cmd: "open", args: ["https://x.dev"] });
    expect(openCommand("C:\\a\\b.pdf", "win32")).toEqual({ cmd: "cmd", args: ["/c", "start", "", "C:\\a\\b.pdf"] });
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

  it("skips Windows roots that are not set", () => {
    expect(browserCandidates({ LOCALAPPDATA: "C:\\L" }, "win32")).toHaveLength(3);
  });
});
