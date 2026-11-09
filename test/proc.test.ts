import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/util/exec.js";
import { AbortedError, abortAll, killTree, parseProcStat, parsePs, processAlive, treeOf, withProcessScope } from "../src/util/proc.js";

const posix = process.platform !== "win32";
const GRACE = 300;

/** PIDs a test started: killed at the end even when an assertion failed, so nothing leaks. Never a pattern kill. */
const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

async function waitFor<T>(get: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

/**
 * A fake render child: ignores SIGTERM, starts a grandchild that sleeps (same
 * process group) and one in its own process group that also ignores SIGTERM
 * (as puppeteer starts Chrome), then writes the three PIDs to `pidsFile`.
 */
const fakeRender = (pidsFile: string) => `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
const own = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
require("node:fs").writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, sleeper.pid, own.pid]));
setInterval(() => {}, 1000);
`;

const readPids = (file: string) => waitFor(async () => (existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as number[]) : undefined));

describe.skipIf(!posix)("abort kills the whole render tree (POSIX, real processes)", () => {
  // Review Focus 4.
  it("kills a child that ignores SIGTERM, its sleeping grandchild and a grandchild in its own process group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-proc-"));
    const pidsFile = join(dir, "pids.json");
    const job = withProcessScope(() => run(process.execPath, ["-e", fakeRender(pidsFile)]));
    job.catch(() => {});
    const pids = await readPids(pidsFile);
    started.push(...pids);
    expect(pids.every(processAlive)).toBe(true);
    const t0 = performance.now();
    expect(await abortAll("test abort", { graceMs: GRACE })).toBe(1);
    // SIGTERM was ignored, so the grace ran out before SIGKILL.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(GRACE - 20);
    await expect(job).rejects.toBeInstanceOf(AbortedError);
    await expect(job).rejects.toThrow("test abort");
    for (const pid of pids) expect(processAlive(pid), `pid ${pid}`).toBe(false);
  });

  it("starts every child of a scope in its own process group, and children outside a scope in ours", async () => {
    const pgid = "ps -o pgid= -p $$; echo $$";
    const inScope = (await withProcessScope(() => run("sh", ["-c", pgid]))).stdout.trim().split(/\s+/).map(Number);
    expect(inScope[0]).toBe(inScope[1]);
    const outside = (await run("sh", ["-c", pgid])).stdout.trim().split(/\s+/).map(Number);
    const ours = Number((await run("ps", ["-o", "pgid=", "-p", String(process.pid)])).stdout.trim());
    expect(outside[0]).toBe(ours);
  });

  it("starts nothing once the scope is aborted", async () => {
    const marker = join(await mkdtemp(join(tmpdir(), "sp-proc-")), "should-not-exist");
    await withProcessScope(async () => {
      const first = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      first.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      await abortAll("stopped", { graceMs: GRACE });
      await expect(first).rejects.toBeInstanceOf(AbortedError);
      await expect(run(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`])).rejects.toBeInstanceOf(AbortedError);
    }).catch(() => {});
    expect(existsSync(marker)).toBe(false);
  });

  it("aborts through an AbortSignal (MCP request cancelled)", async () => {
    const ctrl = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "sp-proc-"));
    const pidsFile = join(dir, "pids.json");
    const job = withProcessScope(() => run(process.execPath, ["-e", fakeRender(pidsFile)]), { signal: ctrl.signal, graceMs: GRACE });
    job.catch(() => {});
    const pids = await readPids(pidsFile);
    started.push(...pids);
    ctrl.abort();
    await expect(job).rejects.toBeInstanceOf(AbortedError);
    await waitFor(async () => (pids.some(processAlive) ? undefined : true), 5000);
  });

  it("nested scopes share the outer one: one abort reaches both", async () => {
    let started = false;
    const outer = withProcessScope(() =>
      withProcessScope(async () => {
        started = true;
        return run(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      }),
    );
    outer.catch(() => {});
    await waitFor(async () => (started ? true : undefined));
    await new Promise((r) => setTimeout(r, 100));
    expect(await abortAll("x", { graceMs: GRACE })).toBe(1);
    await expect(outer).rejects.toBeInstanceOf(AbortedError);
  });

  it("returns 0 and does nothing when no render is running", async () => {
    expect(await abortAll("nothing")).toBe(0);
  });

  // The CLI (Ctrl-C) and the MCP server (client gone) exit on SIGINT/SIGTERM: the detached render tree must die too.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    it(`kills the tree when the process gets ${sig}`, { timeout: 60_000 }, async () => {
      const dir = await mkdtemp(join(tmpdir(), "sp-proc-"));
      const pidsFile = join(dir, "pids.json");
      const script = join(dir, "host.mts");
      const src = (p: string) => JSON.stringify(pathToFileURL(resolve(p)).href);
      await writeFile(
        script,
        `import { run } from ${src("src/util/exec.ts")};
import { withProcessScope } from ${src("src/util/proc.ts")};
await withProcessScope(() => run(process.execPath, ["-e", ${JSON.stringify(fakeRender(pidsFile))}]));
`,
      );
      const host = spawn(process.execPath, ["--import", "tsx", script], { cwd: resolve("."), stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, SCREENPILOT_KILL_GRACE_MS: String(GRACE) } });
      started.push(host.pid!);
      let stderr = "";
      host.stderr.on("data", (d: Buffer) => (stderr += d));
      const exited = new Promise<number | null>((r) => host.on("exit", (code) => r(code)));
      const pids = await readPids(pidsFile);
      started.push(...pids);
      host.kill(sig);
      const code = await exited;
      // It exits by itself (not killed by the signal): 128 + the signal, or 1 when the aborted render's error got there first.
      expect([sig === "SIGINT" ? 130 : 143, 1], stderr).toContain(code);
      await waitFor(async () => (pids.some(processAlive) ? undefined : true), 5000);
    });
  }
});

describe("Windows: taskkill /T /F (runner injected)", () => {
  it("kills the tree with taskkill", async () => {
    const calls: [string, string[]][] = [];
    await killTree(4321, { platform: "win32", runner: async (cmd, args) => void calls.push([cmd, args]) });
    expect(calls).toEqual([["taskkill", ["/PID", "4321", "/T", "/F"]]]);
  });

  it("abortAll sends every child of a running render to taskkill", async () => {
    const calls: string[][] = [];
    let pid = 0;
    const job = withProcessScope(() => {
      const p = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      return p;
    });
    job.catch(() => {});
    // The child is real (this machine is not Windows): find it, then let the fake taskkill record the call.
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await abortAll("x", {
        platform: "win32",
        runner: async (_cmd, args) => {
          calls.push(args);
          pid = Number(args[1]);
          process.kill(pid, "SIGKILL");
        },
      }),
    ).toBe(1);
    await expect(job).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toEqual([["/PID", String(pid), "/T", "/F"]]);
  });
});

describe("process table", () => {
  it("parses /proc/<pid>/stat, even when the command name has spaces and parentheses", () => {
    expect(parseProcStat("1234 (chrome (renderer) x) S 1200 1199 1199 0 -1 4194560")).toEqual({ pid: 1234, ppid: 1200, pgid: 1199, zombie: false });
    expect(parseProcStat("77 (sleep) Z 1 77 77")).toEqual({ pid: 77, ppid: 1, pgid: 77, zombie: true });
  });

  it("parses ps -A -o pid=,ppid=,pgid=,stat=", () => {
    const t = parsePs("  10     1    10 Ss\n  11    10    10 S+\n  12    11    12 Z\n");
    expect([...t.values()]).toEqual([
      { pid: 10, ppid: 1, pgid: 10, zombie: false },
      { pid: 11, ppid: 10, pgid: 10, zombie: false },
      { pid: 12, ppid: 11, pgid: 12, zombie: true },
    ]);
  });

  it("collects every descendant and their process groups, never our own group", () => {
    const t = parsePs(["100 1 100 S", "200 100 200 S", "201 200 200 S", "202 201 300 S", "300 1 300 S", "400 201 50 S", "500 1 500 S"].join("\n"));
    const tree = treeOf(200, t, 50);
    expect([...tree.pids].sort()).toEqual([200, 201, 202, 400]);
    expect([...tree.groups].sort()).toEqual([200, 300]);
  });

  it("falls back to the child's own group when the table does not list it", () => {
    const tree = treeOf(42, new Map(), 1);
    expect([...tree.pids]).toEqual([42]);
    expect([...tree.groups]).toEqual([42]);
  });
});
