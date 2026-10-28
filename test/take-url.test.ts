import { describe, expect, it } from "vitest";
import { pageUrl } from "../src/take/perform.js";

describe("take page URLs", () => {
  it("keeps URLs as they are", () => {
    expect(pageUrl("https://example.com/a?b", "/x")).toBe("https://example.com/a?b");
    expect(pageUrl("about:blank", "/x")).toBe("about:blank");
    expect(pageUrl("file:///tmp/p.html", "/x")).toBe("file:///tmp/p.html");
  });

  it("resolves file paths against the take's folder, so a take works from any checkout", () => {
    expect(pageUrl("site/index.html", "/home/u/repo/assets/demo")).toBe("file:///home/u/repo/assets/demo/site/index.html");
    expect(pageUrl("../page with space.html", "/r/a")).toBe("file:///r/page%20with%20space.html");
    expect(pageUrl("/abs/p.html", "/r")).toBe("file:///abs/p.html");
  });
});
