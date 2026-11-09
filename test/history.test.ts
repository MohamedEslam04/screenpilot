import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importLibrary } from "../src/history/import.js";
import { readHistory, recordEvent } from "../src/history/index.js";
import { listJobs, startJob } from "../src/history/jobs.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-hist-"));
  file = join(dir, "history.jsonl");
});

const ev = (i: number) => ({ kind: "render" as const, status: "ok" as const, path: `/p/${i}`, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });

describe("history file", () => {
  it("returns newest first and pages with before", async () => {
    for (let i = 0; i < 10; i++) await recordEvent(ev(i), file);
    const first = await readHistory({ file, limit: 4 });
    expect(first.map((e) => e.path)).toEqual(["/p/9", "/p/8", "/p/7", "/p/6"]);
    const next = await readHistory({ file, limit: 4, before: first.at(-1)!.at });
    expect(next.map((e) => e.path)).toEqual(["/p/5", "/p/4", "/p/3", "/p/2"]);
  });

  it("reads across block boundaries and skips torn lines", async () => {
    const pad = "x".repeat(300);
    const lines = Array.from({ length: 800 }, (_, i) => JSON.stringify({ v: 1, ...ev(i), error: pad }));
    lines.splice(400, 0, "{not json");
    await writeFile(file, `${lines.join("\n")}\n`);
    const all = await readHistory({ file, limit: 1000 });
    expect(all).toHaveLength(800);
    expect(all[0]!.path).toBe("/p/799");
    expect(all.at(-1)!.path).toBe("/p/0");
  });

  it("is empty for a missing file and never throws when it cannot write", async () => {
    expect(await readHistory({ file: join(dir, "none.jsonl") })).toEqual([]);
    await expect(recordEvent(ev(1), join(file, "nested", "x.jsonl"))).resolves.toBeUndefined();
  });
});

describe("SCREENPILOT_NO_HISTORY", () => {
  const saved = { off: process.env.SCREENPILOT_NO_HISTORY, xdg: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME };
  afterEach(() => {
    for (const [k, v] of [["SCREENPILOT_NO_HISTORY", saved.off], ["XDG_CONFIG_HOME", saved.xdg], ["XDG_CACHE_HOME", saved.cache]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("leaves the default history and job folders alone, but an explicit file still works", async () => {
    process.env.SCREENPILOT_NO_HISTORY = "1";
    process.env.XDG_CONFIG_HOME = join(dir, "cfg");
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    await recordEvent(ev(1));
    startJob({ kind: "render", path: "/x.json" }).end();
    expect(existsSync(join(dir, "cfg"))).toBe(false);
    expect(existsSync(join(dir, "cache"))).toBe(false);
    await recordEvent(ev(2), file);
    expect(await readHistory({ file })).toHaveLength(1);
  });
});

describe("importLibrary", () => {
  it("adds recordings and renders once, in time order", async () => {
    const session = join(dir, "sessions", "2026-01-01_10-00-00");
    await mkdir(session, { recursive: true });
    await writeFile(join(session, "meta.json"), JSON.stringify({ video: "rec.mp4", videoInfo: { duration: 12 } }));
    await writeFile(join(session, "storyboard.json"), "{}");
    await writeFile(join(session, "storyboard.mp4"), "x");
    await recordEvent({ ...ev(1), at: "2020-01-01T00:00:00.000Z" }, file);
    const r = await importLibrary([join(dir, "sessions")], file);
    expect(r.added).toBe(2);
    expect((await importLibrary([join(dir, "sessions")], file)).added).toBe(0);
    const all = await readHistory({ file, limit: 10 });
    expect(all).toHaveLength(3);
    expect(all.at(-1)!.at).toBe("2020-01-01T00:00:00.000Z");
    expect(all.find((e) => e.kind === "record")).toMatchObject({ durationSec: 12, imported: true });
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
  });
});

describe("jobs", () => {
  it("shows a running job with its step and removes it at the end", () => {
    const jobs = join(dir, "jobs");
    const job = startJob({ kind: "render", path: "/sb.json", quality: "draft" }, jobs);
    job.update({ label: "chunk", index: 2, total: 5 });
    const [running] = listJobs(jobs);
    expect(running).toMatchObject({ kind: "render", path: "/sb.json", pid: process.pid, step: { index: 2, total: 5 } });
    job.end();
    expect(listJobs(jobs)).toEqual([]);
  });

  it("drops a job whose process is gone", async () => {
    const jobs = join(dir, "jobs");
    await mkdir(jobs);
    await writeFile(join(jobs, "dead.json"), JSON.stringify({ id: "dead", pid: 2 ** 22 + 12345, kind: "render", path: "/x", startedAt: "", updatedAt: "" }));
    expect(listJobs(jobs)).toEqual([]);
    expect(listJobs(jobs)).toEqual([]);
  });
});
