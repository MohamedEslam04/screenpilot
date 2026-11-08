import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freeSessionDir, prepareSessionDir } from "../src/take/session-dir.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sp-session-dir-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("freeSessionDir", () => {
  it("uses a missing dir as is", async () => {
    const x = join(root, "x");
    expect(await freeSessionDir(x)).toBe(x);
  });

  it("reuses an empty dir", async () => {
    const x = join(root, "x");
    await mkdir(x);
    expect(await freeSessionDir(x)).toBe(x);
  });

  it("gives x-2, then x-3, when earlier takes are in the way", async () => {
    const x = join(root, "x");
    await mkdir(x);
    await writeFile(join(x, "video.mp4"), "old");
    expect(await freeSessionDir(x)).toBe(`${x}-2`);
    await mkdir(`${x}-2`);
    await writeFile(join(`${x}-2`, "video.mp4"), "old");
    expect(await freeSessionDir(x)).toBe(`${x}-3`);
  });

  it("reuses an empty x-2 before going on", async () => {
    const x = join(root, "x");
    await mkdir(x);
    await writeFile(join(x, "a"), "old");
    await mkdir(`${x}-2`);
    expect(await freeSessionDir(x)).toBe(`${x}-2`);
  });
});

describe("prepareSessionDir", () => {
  it("creates the dir and points <dir>-latest at it", async () => {
    const x = join(root, "x");
    const used = await prepareSessionDir(x);
    expect(used).toBe(x);
    expect(existsSync(x)).toBe(true);
    expect(await realpath(`${x}-latest`)).toBe(await realpath(x));
  });

  it("points <dir>-latest at the versioned dir actually used, and moves it on the next retake", async () => {
    const x = join(root, "x");
    await mkdir(x);
    await writeFile(join(x, "video.mp4"), "old");
    expect(await prepareSessionDir(x)).toBe(`${x}-2`);
    expect(await realpath(`${x}-latest`)).toBe(await realpath(`${x}-2`));
    await writeFile(join(`${x}-2`, "video.mp4"), "old");
    expect(await prepareSessionDir(x)).toBe(`${x}-3`);
    expect(await realpath(`${x}-latest`)).toBe(await realpath(`${x}-3`));
    expect((await lstat(`${x}-latest`)).isSymbolicLink()).toBe(true);
    expect(await readlink(`${x}-latest`)).toBe("x-3");
  });

  it("overwrite moves the previous take to <dir>.prev, replacing an older .prev", async () => {
    const x = join(root, "x");
    await mkdir(`${x}.prev`);
    await writeFile(join(`${x}.prev`, "ancient"), "1");
    await mkdir(x);
    await writeFile(join(x, "video.mp4"), "second");
    expect(await prepareSessionDir(x, { overwrite: true })).toBe(x);
    expect(await readFile(join(`${x}.prev`, "video.mp4"), "utf8")).toBe("second");
    expect(existsSync(join(`${x}.prev`, "ancient"))).toBe(false);
    expect(existsSync(join(x, "video.mp4"))).toBe(false);
    expect(await realpath(`${x}-latest`)).toBe(await realpath(x));
  });

  it("overwrite on a fresh dir changes nothing", async () => {
    const x = join(root, "x");
    expect(await prepareSessionDir(x, { overwrite: true })).toBe(x);
    expect(existsSync(`${x}.prev`)).toBe(false);
  });
});
