import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP, configDir, isOurs, named } from "../src/brand.js";

const saved = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
});

describe("brand", () => {
  it("names things after the app", () => {
    expect(named("multi")).toBe(`${APP}-multi`);
    expect(isOurs(`${APP}-screen`)).toBe(true);
    expect(isOurs("PC Screen")).toBe(false);
  });

  it("moves the config folder over from a previous name on first use", () => {
    const base = mkdtempSync(join(tmpdir(), "brand-"));
    process.env.XDG_CONFIG_HOME = base;
    mkdirSync(join(base, "oldname"));
    writeFileSync(join(base, "oldname", "state.json"), "{}");
    const dir = configDir("newname", ["oldname"]);
    expect(dir).toBe(join(base, "newname"));
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(base, "oldname"))).toBe(false);
  });
});
