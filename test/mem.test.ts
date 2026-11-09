import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  childRssBytes,
  MemoryGuardError,
  memGuardSettings,
  parseMemInfo,
  parseVmStat,
  readAvailableMemory,
  startRssSampler,
  waitForMemory,
} from "../src/util/mem.js";

const MB = 1024 * 1024;

describe("parseMemInfo", () => {
  it("reads MemAvailable, not MemFree (page cache counts as available on Linux)", () => {
    const text = "MemTotal:       32000000 kB\nMemFree:          500000 kB\nMemAvailable:   12000000 kB\nBuffers:          100000 kB\nCached:          9000000 kB\n";
    expect(parseMemInfo(text)).toEqual({ availableBytes: 12000000 * 1024, totalBytes: 32000000 * 1024 });
  });

  it("falls back to MemFree + Buffers + Cached on an old kernel without MemAvailable", () => {
    const text = "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 20 kB\nCached: 300 kB\n";
    expect(parseMemInfo(text)?.availableBytes).toBe(420 * 1024);
  });

  it("gives undefined for text it does not understand", () => {
    expect(parseMemInfo("nothing here")).toBeUndefined();
  });
});

describe("parseVmStat", () => {
  it("counts free, inactive, speculative and purgeable pages at the reported page size", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               1000.",
      "Pages active:                            50000.",
      "Pages inactive:                           2000.",
      "Pages speculative:                         300.",
      "Pages wired down:                        40000.",
      "Pages purgeable:                            10.",
    ].join("\n");
    expect(parseVmStat(text)).toBe((1000 + 2000 + 300 + 10) * 16384);
  });

  it("gives undefined without a page size or free pages", () => {
    expect(parseVmStat("Pages free: 10.")).toBeUndefined();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)")).toBeUndefined();
  });
});

describe("readAvailableMemory", () => {
  it("returns a positive number of bytes on this machine", async () => {
    const bytes = await readAvailableMemory();
    expect(bytes).toBeGreaterThan(0);
  });
});

describe("memGuardSettings", () => {
  it("defaults to 1500 MB and 300 s", () => {
    expect(memGuardSettings({}, {})).toEqual({ minBytes: 1500 * MB, timeoutMs: 300_000 });
  });

  it("takes the options, then SCREENPILOT_MIN_FREE_MEM, and 0 turns the guard off", () => {
    expect(memGuardSettings({ minFreeMemMB: 800, memTimeoutS: 5 }, { SCREENPILOT_MIN_FREE_MEM: "2000" })).toEqual({ minBytes: 800 * MB, timeoutMs: 5000 });
    expect(memGuardSettings({}, { SCREENPILOT_MIN_FREE_MEM: "2000" }).minBytes).toBe(2000 * MB);
    expect(memGuardSettings({ minFreeMemMB: 0 }, {}).minBytes).toBe(0);
  });

  it("rejects a negative or non-numeric value", () => {
    expect(() => memGuardSettings({ minFreeMemMB: -1 }, {})).toThrow(/min-free-mem/);
    expect(() => memGuardSettings({ memTimeoutS: Number.NaN }, {})).toThrow(/mem-timeout/);
    expect(() => memGuardSettings({}, { SCREENPILOT_MIN_FREE_MEM: "lots" })).toThrow(/SCREENPILOT_MIN_FREE_MEM/);
  });
});

describe("waitForMemory", () => {
  it("returns at once when enough memory is available", async () => {
    let reads = 0;
    const r = await waitForMemory({ minBytes: 1500 * MB, timeoutMs: 1000, label: "part 1/3", read: async () => (reads++, 4000 * MB) });
    expect(reads).toBe(1);
    expect(r).toEqual({ availableBytes: 4000 * MB, waitedMs: 0 });
  });

  it("does not read memory at all when the guard is off", async () => {
    let reads = 0;
    await waitForMemory({ minBytes: 0, timeoutMs: 1000, label: "x", read: async () => (reads++, 0) });
    expect(reads).toBe(0);
  });

  it("waits until memory comes back, logging once", async () => {
    const values = [500, 900, 2000].map((v) => v * MB);
    const lines: string[] = [];
    const r = await waitForMemory({ minBytes: 1500 * MB, timeoutMs: 5000, pollMs: 1, label: "chunk 2/4", read: async () => values.shift()!, log: (m) => lines.push(m) });
    expect(r.availableBytes).toBe(2000 * MB);
    expect(lines).toEqual(["chunk 2/4: waiting for memory: 500 MB available, need 1500 MB (up to 5 s)"]);
  });

  it("never blocks forever: after the timeout it fails with the measured numbers", async () => {
    const started = Date.now();
    const err = await waitForMemory({ minBytes: 1500 * MB, timeoutMs: 50, pollMs: 5, label: "part 3/8", read: async () => 820 * MB }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(MemoryGuardError);
    const e = err as MemoryGuardError;
    expect(e.message).toMatch(/^part 3\/8: not enough free memory: 820 MB available, need 1500 MB \(waited 0\.\d+ s\)/);
    expect(e.message).toMatch(/--min-free-mem/);
    expect(e.availableMB).toBe(820);
    expect(e.neededMB).toBe(1500);
  });

  it("with a timeout of 0 reads once and fails at once", async () => {
    let reads = 0;
    await expect(waitForMemory({ minBytes: 10 * MB, timeoutMs: 0, label: "x", read: async () => (reads++, MB) })).rejects.toThrow(/1 MB available, need 10 MB/);
    expect(reads).toBe(1);
  });

  it("fails (does not hang) when memory cannot be read", async () => {
    await expect(waitForMemory({ minBytes: 10 * MB, timeoutMs: 1000, label: "x", read: async () => Number.NaN })).rejects.toThrow(/could not read free memory/);
  });
});

describe("childRssBytes", () => {
  it.skipIf(process.platform === "win32")("sums the memory of the child processes", async () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const bytes = await childRssBytes();
      expect(bytes).toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  });

  it("is undefined where the platform gives no process list", async () => {
    expect(await childRssBytes(process.pid, "win32")).toBeUndefined();
  });
});

describe("startRssSampler", () => {
  it("keeps the highest sample", async () => {
    const samples = [100 * MB, 700 * MB, 300 * MB];
    const s = startRssSampler({ intervalMs: 1, sample: async () => samples.shift() ?? 200 * MB });
    await new Promise((r) => setTimeout(r, 40));
    expect(await s.stop()).toBe(700);
  });

  it("is undefined when no sample could be taken", async () => {
    const s = startRssSampler({ intervalMs: 1, sample: async () => undefined });
    await new Promise((r) => setTimeout(r, 10));
    expect(await s.stop()).toBeUndefined();
  });

  it("is undefined when sampling throws", async () => {
    const s = startRssSampler({ intervalMs: 1, sample: async () => {
      throw new Error("ps missing");
    } });
    await new Promise((r) => setTimeout(r, 10));
    expect(await s.stop()).toBeUndefined();
  });
});
