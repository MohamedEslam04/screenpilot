import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The registry keeps module state (instances, ports), so every test gets a fresh copy of the module.
let web: typeof import("../src/drive/web.js");
beforeEach(async () => {
  vi.resetModules();
  web = await import("../src/drive/web.js");
});

describe("demoBrowser registry", () => {
  it("returns the same instance for the same id", () => {
    expect(web.demoBrowser("user")).toBe(web.demoBrowser("user"));
    expect(web.demoBrowser()).toBe(web.demoBrowser("main"));
    expect(web.demoBrowser("user")).not.toBe(web.demoBrowser("main"));
  });

  it("gives main 9333, then 9334 and 9335 to the next distinct ids in order of first use", () => {
    expect(web.demoBrowser("main").port).toBe(9333);
    expect(web.demoBrowser("user").port).toBe(9334);
    expect(web.demoBrowser("admin").port).toBe(9335);
    expect(web.demoBrowser("user").port).toBe(9334);
  });

  it("assigns the ports cdpPortFor gives, so every caller agrees", () => {
    const ids = ["user", "admin", "main", "user"];
    const viaRegistry = ids.map((id) => web.demoBrowser(id).port);
    expect(viaRegistry).toEqual([9334, 9335, 9333, 9334]);
    for (const id of ids) expect(web.cdpPortFor(id)).toBe(web.demoBrowser(id).port);
  });

  it.each(["", "two words", "a/b", "../x"])("rejects the id %j and names the allowed characters", (id) => {
    expect(() => web.demoBrowser(id)).toThrow(/letters, digits, - and _/);
  });

  it("does not use up a port on a rejected id", () => {
    expect(() => web.demoBrowser("bad id")).toThrow();
    expect(web.demoBrowser("user").port).toBe(9334);
  });

  it("is the only way perform and the MCP tools get a browser (no second registry)", () => {
    for (const file of ["../src/take/perform.ts", "../src/mcp.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, file).not.toMatch(/new DemoBrowser\(/);
    }
  });
});
