import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_BIN_ENV, dashboardBin, desktopEntry, desktopEntryFile, syncDesktopEntry } from "../src/dashboard/launch.js";

let dir: string;
const saved = { bin: process.env[DASHBOARD_BIN_ENV], data: process.env.XDG_DATA_HOME };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-dash-"));
  process.env.XDG_DATA_HOME = dir;
  delete process.env[DASHBOARD_BIN_ENV];
});
afterEach(() => {
  restore(DASHBOARD_BIN_ENV, saved.bin);
  restore("XDG_DATA_HOME", saved.data);
});

describe("dashboard launcher", () => {
  it("is not installed until the program exists", async () => {
    expect(dashboardBin()).toBeUndefined();
    const bin = join(dir, "screenpilot-dashboard");
    await writeFile(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    process.env[DASHBOARD_BIN_ENV] = bin;
    expect(dashboardBin()).toBe(bin);
    process.env[DASHBOARD_BIN_ENV] = join(dir, "missing");
    expect(dashboardBin()).toBeUndefined();
  });

  it("quotes the program path in the desktop entry", () => {
    const text = desktopEntry('/home/a b/"x"/screenpilot-dashboard');
    expect(text).toContain('Exec="/home/a b/\\"x\\"/screenpilot-dashboard"');
    expect(text).toContain("Terminal=false");
  });

  it.runIf(process.platform === "linux")("adds the menu entry only when installed, and removes it", async () => {
    expect(syncDesktopEntry(false)).toBeUndefined();
    const bin = join(dir, "screenpilot-dashboard");
    await mkdir(dir, { recursive: true });
    await writeFile(bin, "x");
    process.env[DASHBOARD_BIN_ENV] = bin;
    expect(syncDesktopEntry(false)?.status).toBe("added");
    expect(await readFile(desktopEntryFile(), "utf8")).toContain(`Exec="${bin}"`);
    expect(syncDesktopEntry(true)?.status).toBe("removed");
    expect(syncDesktopEntry(true)).toBeUndefined();
  });
});
