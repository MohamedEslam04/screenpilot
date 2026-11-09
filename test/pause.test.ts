import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPausedState, PAUSE_FILE, PAUSED_STATE_FILE, pauseRenders, pauseRequested, type PausedState, requestPause, writePausedState } from "../src/render/pause.js";
import type { JobInfo } from "../src/history/jobs.js";

const tempDir = () => mkdtemp(join(tmpdir(), "sp-pause-"));

const state = (dir: string, buildDir: string, extra: Partial<PausedState> = {}): PausedState => ({
  version: 1,
  kind: "sequence",
  path: join(dir, "seq.json"),
  buildDir,
  pausedAt: new Date().toISOString(),
  options: { quality: "draft" },
  ...extra,
});

describe("requestPause", () => {
  it("drops .pause into every build folder of that file (styles, windows and formats have their own)", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "seq.build"));
    await mkdir(join(dir, "seq.dark.build"));
    await mkdir(join(dir, "other.build"));
    const dirs = await requestPause({ path: join(dir, "seq.json") });
    expect(dirs.sort()).toEqual([join(dir, "seq.build"), join(dir, "seq.dark.build")]);
    expect(existsSync(join(dir, "seq.build", PAUSE_FILE))).toBe(true);
    expect(existsSync(join(dir, "other.build", PAUSE_FILE))).toBe(false);
  });

  it("creates the default build folder when the render has not made it yet", async () => {
    const dir = await tempDir();
    expect(await requestPause({ path: join(dir, "demo.json") })).toEqual([join(dir, "demo.build")]);
    expect(existsSync(join(dir, "demo.build", PAUSE_FILE))).toBe(true);
  });

  it("takes an explicit build folder", async () => {
    const dir = await tempDir();
    const build = join(dir, "custom");
    expect(await requestPause({ buildDir: build })).toEqual([build]);
    expect(existsSync(join(build, PAUSE_FILE))).toBe(true);
  });

  it("needs a path or a build folder", async () => {
    await expect(requestPause({})).rejects.toThrow(/path or a build folder/);
  });
});

describe("pauseRequested", () => {
  it("is true only for a request made after the render started", async () => {
    const dir = await tempDir();
    const since = Date.now();
    expect(pauseRequested(dir, since)).toBe(false);
    await writeFile(join(dir, PAUSE_FILE), "{}");
    expect(pauseRequested(dir, since)).toBe(true);
    // A request left from before this render started (nothing was running then) is stale.
    const old = new Date(since - 60_000);
    await utimes(join(dir, PAUSE_FILE), old, old);
    expect(pauseRequested(dir, since)).toBe(false);
  });
});

describe("paused state", () => {
  it("is found next to the file it belongs to, newest first", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "seq.build"));
    await mkdir(join(dir, "seq.dark.build"));
    await writePausedState(state(dir, join(dir, "seq.build"), { pausedAt: "2026-11-09T10:00:00.000Z" }));
    await writePausedState(state(dir, join(dir, "seq.dark.build"), { pausedAt: "2026-11-09T11:00:00.000Z" }));
    expect((await findPausedState(join(dir, "seq.json")))?.buildDir).toBe(join(dir, "seq.dark.build"));
    expect((await findPausedState(join(dir, "seq.json"), join(dir, "seq.build")))?.buildDir).toBe(join(dir, "seq.build"));
    expect(JSON.parse(await readFile(join(dir, "seq.build", PAUSED_STATE_FILE), "utf8"))).toMatchObject({ version: 1, kind: "sequence" });
  });

  it("ignores a state written for another file", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "seq.build"));
    await writePausedState(state(dir, join(dir, "seq.build"), { path: join(dir, "elsewhere", "seq.json") }));
    expect(await findPausedState(join(dir, "seq.json"))).toBeUndefined();
  });

  it("is undefined when nothing was paused", async () => {
    const dir = await tempDir();
    expect(await findPausedState(join(dir, "seq.json"))).toBeUndefined();
  });
});

describe("pauseRenders", () => {
  const job = (path: string, kind: JobInfo["kind"] = "sequence"): JobInfo => ({ id: "1", pid: process.pid, kind, path, startedAt: "", updatedAt: "" });

  it("without a path pauses every running render and sequence", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "seq.build"));
    const r = await pauseRenders({}, [job(join(dir, "seq.json")), job(join(dir, "demo.json"), "render")]);
    expect(r.running).toEqual([{ kind: "sequence", path: join(dir, "seq.json") }, { kind: "render", path: join(dir, "demo.json") }]);
    expect(r.requested.sort()).toEqual([join(dir, "demo.build"), join(dir, "seq.build")]);
  });

  it("says so when nothing is running and no path was given", async () => {
    await expect(pauseRenders({}, [])).rejects.toThrow(/Nothing is rendering/);
  });

  it("with a path writes the request even when no job file says it runs (another user, history off)", async () => {
    const dir = await tempDir();
    const r = await pauseRenders({ path: join(dir, "seq.json") }, []);
    expect(r).toEqual({ requested: [join(dir, "seq.build")], running: [] });
  });
});
