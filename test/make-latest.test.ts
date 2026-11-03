import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { parseLatest } from "../src/update/manifest.js";

const script = join(import.meta.dirname, "..", "scripts", "ci", "make-latest.mjs");
const sh = promisify(execFile);
let dir: string;

async function release(version = "0.6.0", key = "linux-x64", opts: { sha?: string; skipArchive?: boolean } = {}) {
  const file = `ScreenPilot-app-${key}.tar.gz`;
  const bytes = Buffer.from(`archive of ${key}`);
  if (!opts.skipArchive) await writeFile(join(dir, file), bytes);
  const sha256 = opts.sha ?? createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(dir, `app-${key}.json`), JSON.stringify({ key, version, file, sha256, size: bytes.length, runtime: `rt-${key}` }));
}

const make = (...extra: string[]) => sh(process.execPath, [script, dir, "--repo", "owner/name", "--tag", "v0.6.0", ...extra]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-latest-"));
});

describe("make-latest", () => {
  it("writes a latest.json the updater accepts, with the real hash, and removes the notes", async () => {
    await release("0.6.0", "linux-x64");
    await release("0.6.0", "macos-arm64");
    await make();
    const latest = parseLatest(JSON.parse(await readFile(join(dir, "latest.json"), "utf8")));
    expect(latest.version).toBe("0.6.0");
    expect(Object.keys(latest.platforms).sort()).toEqual(["linux-x64", "macos-arm64"]);
    const e = latest.platforms["linux-x64"]!;
    expect(e.url).toBe("https://github.com/owner/name/releases/download/v0.6.0/ScreenPilot-app-linux-x64.tar.gz");
    expect(e.sha256).toBe(createHash("sha256").update("archive of linux-x64").digest("hex"));
    expect(e.runtime).toBe("rt-linux-x64");
    expect(existsSync(join(dir, "app-linux-x64.json"))).toBe(false);
  });

  it("fails when a note's version is not the tag's", async () => {
    await release("0.5.9");
    await expect(make()).rejects.toThrow(/0\.5\.9/);
  });

  it("fails when the archive named by a note is missing", async () => {
    await release("0.6.0", "linux-x64", { skipArchive: true });
    await expect(make()).rejects.toThrow(/not in/);
  });

  it("fails when the archive differs from what the package job hashed", async () => {
    await release("0.6.0", "linux-x64", { sha: "11".repeat(32) });
    await expect(make()).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(dir, "latest.json"))).toBe(false);
  });

  it("fails when there are no notes", async () => {
    await expect(make()).rejects.toThrow(/no app-/);
  });
});
