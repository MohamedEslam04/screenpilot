import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { runCommand } from "../src/take/run.js";
import { StepSchema } from "../src/take/schema.js";

const base = { cwd: tmpdir(), wait: true, timeoutMs: 5000 };

describe("runCommand", () => {
  it("rejects with the exit code when the program fails", async () => {
    await expect(runCommand(["node", "-e", "process.exit(3)"], base)).rejects.toThrow(/exited with 3/);
  });

  it("includes the end of stderr in the failure", async () => {
    await expect(runCommand(["node", "-e", "console.error('boom'); process.exit(1)"], base)).rejects.toThrow(/boom/);
  });

  it("kills a program that never exits and says it was still running", async () => {
    const t0 = Date.now();
    await expect(
      runCommand(["node", "-e", "setTimeout(()=>{},60000)"], { ...base, timeoutMs: 300 }),
    ).rejects.toThrow(/still running after/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("kills the whole process group, not just the first process", async () => {
    // The parent spawns a grandchild that prints its pid, then both wait.
    const script =
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});" +
      "require('fs').writeFileSync(process.argv[1], String(c.pid)); setTimeout(()=>{},60000)";
    const pidFile = `${tmpdir()}/screenpilot-run-test-${process.pid}.pid`;
    await expect(runCommand(["node", "-e", script, pidFile], { ...base, timeoutMs: 600 })).rejects.toThrow(
      /still running/,
    );
    const { readFileSync, rmSync } = await import("node:fs");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    rmSync(pidFile, { force: true });
    await new Promise((r) => setTimeout(r, 200));
    let alive = true;
    try {
      process.kill(grandchild, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  describe("a background child that keeps the pipes open (wl-copy)", () => {
    // The program exits 0 at once, but leaves a detached grandchild holding its stdout/stderr.
    const spawnLinger = (tail: string) =>
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)']," +
      "{detached:true,stdio:'inherit'});c.unref();" +
      "require('fs').writeFileSync(process.argv[1], String(c.pid));" +
      tail;
    const pidFile = `${tmpdir()}/screenpilot-run-linger-${process.pid}.pid`;
    const killGrandchild = async () => {
      const { readFileSync, rmSync } = await import("node:fs");
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(pidFile, { force: true });
    };
    const isAlive = async () => {
      const { readFileSync } = await import("node:fs");
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), 0);
        return true;
      } catch {
        return false;
      }
    };

    it("returns when the program exits, not when its pipes close, and leaves the grandchild alone", async () => {
      try {
        const t0 = Date.now();
        await expect(runCommand(["node", "-e", spawnLinger("process.exit(0)"), pidFile], base)).resolves.toBeUndefined();
        expect(Date.now() - t0).toBeLessThan(2500);
        expect(await isAlive()).toBe(true);
      } finally {
        await killGrandchild();
      }
    });

    it("still fails with the exit code and stderr when the program fails", async () => {
      try {
        const t0 = Date.now();
        await expect(
          runCommand(["node", "-e", spawnLinger("console.error('copy failed');process.exit(2)"), pidFile], base),
        ).rejects.toThrow(/exited with 2: copy failed/);
        expect(Date.now() - t0).toBeLessThan(2500);
      } finally {
        await killGrandchild();
      }
    });
  });

  it("keeps the output written just before the program exits", async () => {
    await expect(
      runCommand(["node", "-e", "process.stderr.write('last words');process.exit(4)"], base),
    ).rejects.toThrow(/exited with 4: last words/);
  });

  it("resolves on a clean exit", async () => {
    await expect(runCommand(["node", "-e", ""], base)).resolves.toBeUndefined();
  });

  it("rejects when the program does not exist", async () => {
    await expect(runCommand(["screenpilot-no-such-program"], base)).rejects.toThrow(/screenpilot-no-such-program/);
  });

  it("does not wait when wait is false", async () => {
    const t0 = Date.now();
    await runCommand(["node", "-e", "setTimeout(()=>{},300)"], { ...base, wait: false });
    expect(Date.now() - t0).toBeLessThan(250);
  });
});

describe("run step schema", () => {
  it("keeps accepting a plain run step", () => {
    expect(StepSchema.safeParse({ run: ["echo", "hi"] }).success).toBe(true);
  });

  it("accepts wait with a timeout", () => {
    expect(StepSchema.safeParse({ run: ["wl-copy", "x"], wait: true, timeout: 10 }).success).toBe(true);
  });

  it("rejects a timeout without wait", () => {
    expect(StepSchema.safeParse({ run: ["echo"], timeout: 10 }).success).toBe(false);
    expect(StepSchema.safeParse({ run: ["echo"], wait: false, timeout: 10 }).success).toBe(false);
  });

  it("rejects a non-positive timeout", () => {
    expect(StepSchema.safeParse({ run: ["echo"], wait: true, timeout: 0 }).success).toBe(false);
  });
});
