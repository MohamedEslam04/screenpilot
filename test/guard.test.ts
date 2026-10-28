import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, checkAppAllowed, checkEnvAllowed } from "../src/drive/guard.js";

const win = (resourceClass: string, caption: string, active: boolean) => ({ resourceClass, caption, active }) as never;
const desktop = (windows: unknown[], windowControl = true) => ({ windowControl, listWindows: async () => windows }) as never;

describe("guard", () => {
  it("allows any env var when no list is set, only listed ones otherwise", () => {
    expect(() => checkEnvAllowed("HOME", {})).not.toThrow();
    expect(() => checkEnvAllowed("DEMO_PASSWORD", { SCREENPILOT_ALLOW_ENV: "DEMO_PASSWORD, OTHER" })).not.toThrow();
    expect(() => checkEnvAllowed("AWS_SECRET_ACCESS_KEY", { SCREENPILOT_ALLOW_ENV: "DEMO_PASSWORD" })).toThrow(/not allowed/);
  });

  it("limits input to allowed apps by the focused window", async () => {
    const env = { SCREENPILOT_ALLOW_APPS: "firefox,Calculator" };
    const d = desktop([win("code", "editor", false), win("firefox", "Docs", true)]);
    await expect(checkAppAllowed(d, env)).resolves.toBeUndefined();
    await expect(checkAppAllowed(desktop([win("konsole", "~", true)]), env)).rejects.toThrow(/not an allowed app/);
    await expect(checkAppAllowed(desktop([]), env)).rejects.toThrow(/none/);
    await expect(checkAppAllowed(desktop([], false), env)).rejects.toThrow(/cannot tell/);
    await expect(checkAppAllowed(desktop([win("konsole", "~", true)]), {})).resolves.toBeUndefined();
  });

  it("audits actions without the typed text", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "audit-")), "sub", "audit.jsonl");
    await audit("type_text", { text: "hunter2" }, file);
    await audit("click", { target: { x: 0.5, y: 0.5 } }, file);
    const rows = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0].args).toEqual({ text: { chars: 7 } });
    expect(JSON.stringify(rows)).not.toContain("hunter2");
    expect(rows[1].tool).toBe("click");
  });
});
