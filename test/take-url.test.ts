import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { pageUrl } from "../src/take/perform.js";

// Expected file URLs come from the platform's own path rules (on Windows "/r/a" is "D:\r\a").
const fileUrl = (...parts: string[]) => pathToFileURL(resolve(...parts)).href;

describe("take page URLs", () => {
  it("keeps URLs as they are", () => {
    expect(pageUrl("https://example.com/a?b", "/x")).toBe("https://example.com/a?b");
    expect(pageUrl("about:blank", "/x")).toBe("about:blank");
    expect(pageUrl("file:///tmp/p.html", "/x")).toBe("file:///tmp/p.html");
  });

  it("resolves file paths against the take's folder, so a take works from any checkout", () => {
    expect(pageUrl("site/index.html", "/home/u/repo/assets/demo")).toBe(fileUrl("/home/u/repo/assets/demo", "site/index.html"));
    expect(pageUrl("../page with space.html", "/r/a")).toBe(fileUrl("/r/a", "../page with space.html"));
    expect(pageUrl("../page with space.html", "/r/a")).toMatch(/page%20with%20space\.html$/);
    expect(pageUrl("/abs/p.html", "/r")).toBe(fileUrl("/abs/p.html"));
  });

  it("treats a Windows drive path as a path, not a URL scheme", () => {
    expect(pageUrl("C:\\site\\index.html", "/r")).toMatch(/^file:\/\//);
  });
});
