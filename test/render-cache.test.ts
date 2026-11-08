import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheHome } from "../src/brand.js";
import { cacheSize, pruneCache } from "../src/render/cache.js";
import { hyperframesEnv } from "../src/render/index.js";

const MB = 2 ** 20;
const HOUR = 3600_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "screenpilot-cache-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(name: string, bytes: number, ageMs: number, now: number, asDir = false) {
  const path = join(dir, name);
  if (asDir) {
    mkdirSync(join(path, "sub"), { recursive: true });
    writeFileSync(join(path, "sub", "a.bin"), Buffer.alloc(bytes));
  } else {
    writeFileSync(path, Buffer.alloc(bytes));
  }
  const t = new Date(now - ageMs);
  utimesSync(path, t, t);
  return path;
}

describe("pruneCache", () => {
  it("removes the oldest entries first and never one touched in the last 10 minutes", async () => {
    const now = Date.now();
    const old3 = entry("old3", MB, 3 * HOUR, now);
    const old2 = entry("old2", MB, 2 * HOUR, now);
    const fresh = entry("fresh", MB, 60_000, now);
    const r = await pruneCache(dir, 1.5 * MB, now);
    expect(existsSync(old3)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r).toEqual({ removed: 2, freed: 2 * MB });
  });

  it("stops as soon as the cache fits", async () => {
    const now = Date.now();
    const old3 = entry("old3", MB, 3 * HOUR, now);
    const old2 = entry("old2", MB, 2 * HOUR, now);
    const r = await pruneCache(dir, 1.5 * MB, now);
    expect(existsSync(old3)).toBe(false);
    expect(existsSync(old2)).toBe(true);
    expect(r.removed).toBe(1);
  });

  it("counts a directory entry by its recursive size", async () => {
    const now = Date.now();
    const bigDir = entry("big", 2 * MB, 3 * HOUR, now, true);
    const small = entry("small", 100, 2 * HOUR, now);
    expect(await cacheSize(dir)).toBe(2 * MB + 100);
    const r = await pruneCache(dir, MB, now);
    expect(existsSync(bigDir)).toBe(false);
    expect(existsSync(small)).toBe(true);
    expect(r).toEqual({ removed: 1, freed: 2 * MB });
  });

  it("does nothing under the cap or when the folder does not exist", async () => {
    const now = Date.now();
    const a = entry("a", MB, 3 * HOUR, now);
    expect(await pruneCache(dir, 10 * MB, now)).toEqual({ removed: 0, freed: 0 });
    expect(existsSync(a)).toBe(true);
    expect(await pruneCache(join(dir, "missing"), 0, now)).toEqual({ removed: 0, freed: 0 });
    expect(await cacheSize(join(dir, "missing"))).toBe(0);
  });
});

describe("hyperframesEnv", () => {
  const saved = process.env.HYPERFRAMES_EXTRACT_CACHE_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.HYPERFRAMES_EXTRACT_CACHE_DIR;
    else process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = saved;
  });

  it("puts the extract cache in the user cache dir and keeps telemetry off", () => {
    delete process.env.HYPERFRAMES_EXTRACT_CACHE_DIR;
    const env = hyperframesEnv();
    expect(env.HYPERFRAMES_EXTRACT_CACHE_DIR).toBe(join(cacheHome(), "extract"));
    expect(env.HYPERFRAMES_NO_TELEMETRY).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
  });

  it("keeps a user-set extract cache dir", () => {
    process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = "/somewhere/else";
    expect(hyperframesEnv().HYPERFRAMES_EXTRACT_CACHE_DIR).toBe("/somewhere/else");
  });
});

describe("cacheHome", () => {
  it("uses XDG_CACHE_HOME when set on Linux", () => {
    if (process.platform !== "linux") return;
    const saved = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/x/cache";
    try {
      expect(cacheHome()).toBe(join("/x/cache", "screenpilot"));
    } finally {
      if (saved === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved;
    }
  });
});
