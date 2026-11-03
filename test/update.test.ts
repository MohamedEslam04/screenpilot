import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { readFileSync as readFileSyncBuf } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { compareVersions } from "../src/update/version.js";
import { parseLatest, pickPlatform } from "../src/update/manifest.js";
import { platformKey, runtimeId } from "../src/update/runtime.js";
import { applyUpdate, checkForUpdate, dirSource, sourceFrom, tarBin, updateCommand } from "../src/update/index.js";
import { run } from "../src/util/exec.js";

describe("compareVersions", () => {
  it("compares numbers, not text", () => {
    expect(compareVersions("0.5.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.5.0", "0.5.0")).toBe(0);
  });
  it("rejects what is not a version", () => {
    expect(() => compareVersions("latest", "0.5.0")).toThrow(/version/i);
  });
});

describe("platformKey and runtimeId", () => {
  it("names the platform the way the release assets do", () => {
    expect(platformKey("win32", "x64")).toBe("windows-x64");
    expect(platformKey("darwin", "arm64")).toBe("macos-arm64");
    expect(platformKey("darwin", "x64")).toBe("macos-x64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
  });

  it("changes when the dependencies, the Node major or the platform change, and only then", () => {
    const base = { lock: "lock-a", workspace: "ws", nodeMajor: 24, platform: "linux-x64" };
    expect(runtimeId(base)).toBe(runtimeId({ ...base }));
    expect(runtimeId({ ...base, lock: "lock-b" })).not.toBe(runtimeId(base));
    expect(runtimeId({ ...base, workspace: "ws2" })).not.toBe(runtimeId(base));
    expect(runtimeId({ ...base, nodeMajor: 26 })).not.toBe(runtimeId(base));
    expect(runtimeId({ ...base, platform: "windows-x64" })).not.toBe(runtimeId(base));
  });
});

describe("latest.json", () => {
  const entry = { file: "a.tar.gz", url: "https://example.com/a.tar.gz", sha256: "ab".repeat(32), size: 10, runtime: "r1" };
  it("parses and picks the platform", () => {
    const l = parseLatest({ version: "0.6.0", platforms: { "linux-x64": entry } });
    expect(pickPlatform(l, "linux-x64")).toEqual(entry);
    expect(pickPlatform(l, "macos-arm64")).toBeUndefined();
  });
  it("rejects a malformed file", () => {
    expect(() => parseLatest({ version: "0.6.0" })).toThrow();
    expect(() => parseLatest({ version: "soon", platforms: {} })).toThrow();
  });
});

const KEY = "linux-x64";
let dir: string;
let root: string;
let rel: string;
let skill: string;

async function write(file: string, text: string) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}

async function makeInstall(version: string, runtime: string | null) {
  await write(join(root, "dist", "mcp.js"), `old mcp ${version}`);
  await write(join(root, "dist", "cli.js"), `old cli ${version}`);
  await write(join(root, "dist", "only-in-old.js"), "stale");
  await write(join(root, "skill", "SKILL.md"), "old skill");
  await write(join(root, "python", "w.py"), "old py");
  await write(join(root, "package.json"), JSON.stringify({ name: "screenpilot", version }));
  await write(join(root, "bin", "node"), "node binary");
  await write(join(root, "node_modules", "dep", "index.js"), "dep");
  if (runtime) await write(join(root, "runtime.json"), JSON.stringify({ runtime }));
}

interface ReleaseOptions {
  version?: string;
  runtime?: string;
  files?: Record<string, string>;
  sha256?: string;
  members?: string[];
}

/** A release folder: latest.json plus the app archive, built with the real tar. */
async function makeRelease(o: ReleaseOptions = {}) {
  const version = o.version ?? "0.6.0";
  const runtime = o.runtime ?? "r1";
  const stage = join(dir, "stage");
  const files: Record<string, string> = o.files ?? {
    "dist/mcp.js": `new mcp ${version}`,
    "dist/cli.js": `new cli ${version}`,
    "skill/SKILL.md": "new skill",
    "python/w.py": "new py",
    "package.json": JSON.stringify({ name: "screenpilot", version }),
    "runtime.json": JSON.stringify({ runtime }),
  };
  for (const [f, text] of Object.entries(files)) await write(join(stage, f), text);
  const file = `ScreenPilot-app-${KEY}.tar.gz`;
  await mkdir(rel, { recursive: true });
  await run(tarBin(), ["-czf", join(rel, file), "-C", stage, ...(o.members ?? Object.keys(files).map((f) => f.split("/")[0]!).filter((v, i, a) => a.indexOf(v) === i))]);
  const sha256 = o.sha256 ?? createHash("sha256").update(await readFile(join(rel, file))).digest("hex");
  await write(
    join(rel, "latest.json"),
    JSON.stringify({ version, platforms: { [KEY]: { file, url: `https://example.com/${file}`, sha256, size: 1, runtime } } }),
  );
}

const opts = () => ({ root, source: dirSource(rel), platform: KEY, skillDir: skill });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-update-"));
  root = join(dir, "install");
  rel = join(dir, "release");
  skill = join(dir, "claude-skill");
});

describe("checkForUpdate", () => {
  it("says up to date when the release is not newer", async () => {
    await makeInstall("0.6.0", "r1");
    await makeRelease({ version: "0.6.0" });
    expect((await checkForUpdate(opts())).status).toBe("up-to-date");
  });

  it("finds a newer version", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" });
    const r = await checkForUpdate(opts());
    expect(r).toMatchObject({ status: "available", current: "0.5.0", latest: "0.6.0" });
  });

  it("is blocked, with the full download link, when the runtime changed", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0", runtime: "r2" });
    const r = await checkForUpdate(opts());
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/dependencies|runtime/i);
    expect(r.fullDownload).toMatch(/^https:\/\/github\.com\/.+\/releases\/latest$/);
  });

  it("is blocked for an install that has no runtime.json (made before updates existed)", async () => {
    await makeInstall("0.5.0", null);
    await makeRelease({ version: "0.6.0" });
    const r = await checkForUpdate(opts());
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/full package once/i);
  });

  it("is blocked for a developer checkout", async () => {
    await makeInstall("0.5.0", "r1");
    await mkdir(join(root, ".git"));
    await makeRelease({ version: "0.6.0" });
    const r = await checkForUpdate(opts());
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/git pull/i);
  });

  it("is blocked when there is no build for this platform", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" });
    const r = await checkForUpdate({ ...opts(), platform: "windows-x64" });
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/windows-x64/);
  });
});

describe("applyUpdate", () => {
  it("replaces the app files, keeps the runtime, and refreshes the Claude skill", async () => {
    await makeInstall("0.5.0", "r1");
    await write(join(skill, "SKILL.md"), "the copy setup made");
    await makeRelease({ version: "0.6.0" });
    const r = await applyUpdate(opts());
    expect(r).toMatchObject({ from: "0.5.0", to: "0.6.0", skill: true });
    expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("new mcp 0.6.0");
    expect(existsSync(join(root, "dist", "only-in-old.js"))).toBe(false); // stale files go
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.6.0");
    expect(await readFile(join(root, "bin", "node"), "utf8")).toBe("node binary");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("dep");
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("new skill");
    expect(await readFile(join(root, ".update-backup", "0.5.0", "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
    expect(existsSync(join(root, ".update-tmp"))).toBe(false);
  });

  it("leaves the Claude skill alone when setup never made one", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" });
    const r = await applyUpdate(opts());
    expect(r.skill).toBe(false);
    expect(existsSync(skill)).toBe(false);
  });

  it("keeps only the latest backup", async () => {
    await makeInstall("0.4.0", "r1");
    await write(join(root, ".update-backup", "0.3.0", "dist", "mcp.js"), "older");
    await makeRelease({ version: "0.6.0" });
    await applyUpdate(opts());
    expect(await readdir(join(root, ".update-backup"))).toEqual(["0.4.0"]);
  });

  it("refuses a download whose SHA-256 does not match, and changes nothing", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0", sha256: "00".repeat(32) });
    await expect(applyUpdate(opts())).rejects.toThrow(/SHA-256/);
    expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
    expect(existsSync(join(root, ".update-tmp"))).toBe(false);
  });

  it("refuses an archive that is not a complete app, and changes nothing", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({
      version: "0.6.0",
      files: { "skill/SKILL.md": "x", "package.json": JSON.stringify({ version: "0.6.0" }), "runtime.json": JSON.stringify({ runtime: "r1" }) },
    });
    await expect(applyUpdate(opts())).rejects.toThrow(/dist\/mcp\.js/);
    expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
  });

  it("refuses an archive whose package.json is another version than latest.json says", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({
      version: "0.6.0",
      files: {
        "dist/mcp.js": "m",
        "dist/cli.js": "c",
        "package.json": JSON.stringify({ version: "9.9.9" }),
        "runtime.json": JSON.stringify({ runtime: "r1" }),
      },
    });
    await expect(applyUpdate(opts())).rejects.toThrow(/9\.9\.9/);
    expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
  });

  it("refuses files outside the app layer (path tricks)", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({
      version: "0.6.0",
      files: {
        "dist/mcp.js": "m",
        "dist/cli.js": "c",
        "package.json": JSON.stringify({ version: "0.6.0" }),
        "runtime.json": JSON.stringify({ runtime: "r1" }),
        "bin/node": "evil",
      },
    });
    await expect(applyUpdate(opts())).rejects.toThrow(/outside the app files|bin\/node/);
    expect(await readFile(join(root, "bin", "node"), "utf8")).toBe("node binary");
  });

  it.skipIf(process.platform === "win32")("refuses symbolic links in the archive", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" });
    await symlink("/etc/passwd", join(dir, "stage", "dist", "link.js"));
    await run(tarBin(), ["-czf", join(rel, `ScreenPilot-app-${KEY}.tar.gz`), "-C", join(dir, "stage"), "dist", "skill", "python", "package.json", "runtime.json"]);
    const sha = createHash("sha256").update(await readFile(join(rel, `ScreenPilot-app-${KEY}.tar.gz`))).digest("hex");
    const latest = JSON.parse(await readFile(join(rel, "latest.json"), "utf8"));
    latest.platforms[KEY].sha256 = sha;
    await writeFile(join(rel, "latest.json"), JSON.stringify(latest));
    await expect(applyUpdate(opts())).rejects.toThrow(/link/i);
    expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
  });

  it("puts everything back when a step fails half way", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" });
    await expect(
      applyUpdate({
        ...opts(),
        hooks: {
          afterReplace: (item) => {
            if (item === "skill") throw new Error("disk full");
          },
        },
      }),
    ).rejects.toThrow(/rolled back.*disk full/s);
    expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
    expect(existsSync(join(root, "dist", "only-in-old.js"))).toBe(true);
    expect(await readFile(join(root, "skill", "SKILL.md"), "utf8")).toBe("old skill");
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.5.0");
  });

  it("does nothing when already up to date", async () => {
    await makeInstall("0.6.0", "r1");
    await makeRelease({ version: "0.6.0" });
    await expect(applyUpdate(opts())).rejects.toThrow(/already/i);
  });

  it("refuses to update when blocked, with the reason", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0", runtime: "r2" });
    await expect(applyUpdate(opts())).rejects.toThrow(/dependencies|runtime/i);
  });
});

describe("updateCommand", () => {
  it("is the full command for this install: the bundled node, cli.js and update", async () => {
    dir = await mkdtemp(join(tmpdir(), "sp-cmd-"));
    await write(join(dir, "bin", process.platform === "win32" ? "node.exe" : "node"), "x");
    const c = updateCommand(dir);
    expect(c).toContain(join(dir, "bin", process.platform === "win32" ? "node.exe" : "node"));
    expect(c).toContain(join(dir, "dist", "cli.js"));
    expect(c.endsWith(" update")).toBe(true);
    expect(c.startsWith('"')).toBe(true);
  });

  it("falls back to node on PATH when there is no bundled one", async () => {
    dir = await mkdtemp(join(tmpdir(), "sp-cmd-"));
    expect(updateCommand(dir).startsWith("node ")).toBe(true);
  });
});

describe("runtimeId line endings", () => {
  it("is the same for a Windows and a Linux checkout of the same lockfile", () => {
    const a = runtimeId({ lock: "a\nb\n", workspace: "w\n", nodeMajor: 24, platform: "linux-x64" });
    const b = runtimeId({ lock: "a\r\nb\r\n", workspace: "w\r\n", nodeMajor: 24, platform: "linux-x64" });
    expect(a).toBe(b);
  });
});

describe("over HTTP", () => {
  let server: Server;
  let base: string;
  let hits: string[];

  async function serve(handler: (url: string) => { status: number; body?: Buffer | string } | undefined) {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const r = handler(req.url ?? "") ?? { status: 404 };
      res.statusCode = r.status;
      res.end(r.body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const close = () => new Promise((ok) => server.close(ok));

  it("checks and applies an update from a server laid out like the releases", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" });
    await serve((url) => {
      const file = url.slice(1);
      return existsSync(join(rel, file)) ? { status: 200, body: readFileSyncBuf(join(rel, file)) } : undefined;
    });
    try {
      // latest.json carries example.com URLs; point it at this server like a real release would.
      const l = JSON.parse(await readFile(join(rel, "latest.json"), "utf8"));
      l.platforms[KEY].url = `${base}/${l.platforms[KEY].file}`;
      await writeFile(join(rel, "latest.json"), JSON.stringify(l));
      const r = await applyUpdate({ root, source: sourceFrom(base), platform: KEY, skillDir: null });
      expect(r.to).toBe("0.6.0");
      expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("new mcp 0.6.0");
      expect(hits).toEqual(expect.arrayContaining(["/latest.json", `/ScreenPilot-app-${KEY}.tar.gz`]));
    } finally {
      await close();
    }
  });

  it("refuses to download from an address outside the source", async () => {
    await makeInstall("0.5.0", "r1");
    await makeRelease({ version: "0.6.0" }); // its url is https://example.com/...
    await serve((url) => (url === "/latest.json" ? { status: 200, body: readFileSyncBuf(join(rel, "latest.json")) } : undefined));
    try {
      await expect(applyUpdate({ root, source: sourceFrom(base), platform: KEY, skillDir: null })).rejects.toThrow(/outside/);
      expect(await readFile(join(root, "dist", "mcp.js"), "utf8")).toBe("old mcp 0.5.0");
    } finally {
      await close();
    }
  });

  it("explains a missing latest.json (releases before 0.6 publish none)", async () => {
    await makeInstall("0.5.0", "r1");
    await serve(() => undefined);
    try {
      await expect(checkForUpdate({ root, source: sourceFrom(base), platform: KEY })).rejects.toThrow(/latest\.json.*full package/s);
    } finally {
      await close();
    }
  });
});
