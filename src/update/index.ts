import { createHash } from "node:crypto";
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { APP, REPO } from "../brand.js";
import { run } from "../util/exec.js";
import { type Latest, parseLatest, type PlatformEntry, pickPlatform } from "./manifest.js";
import { platformKey, readRuntime } from "./runtime.js";
import { compareVersions } from "./version.js";

// App-only update: replace the files that change with every release (dist, skill,
// python, package.json) and nothing else. Node, ffmpeg and node_modules are the
// runtime layer; when a release changes them the update refuses and points at the
// full package. Everything is checked before anything is touched, and a failure
// half way puts the old files back.

/** What an update replaces. Everything else in the install (bin, node_modules, ...) stays. */
export const APP_ITEMS = ["dist", "skill", "python", "dashboard", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "icon.png", "runtime.json"];

export const FULL_DOWNLOAD = `https://github.com/${REPO}/releases/latest`;
const LATEST_BASE = `${FULL_DOWNLOAD}/download`;
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** `tar` that reads zip and gz everywhere: Windows' own bsdtar (not Git's GNU tar, which treats C: as a host). */
export function tarBin(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The command to run in a terminal to update this install (no `screenpilot` on PATH is needed). */
export function updateCommand(root = packageRoot()): string {
  const node = join(root, "bin", process.platform === "win32" ? "node.exe" : "node");
  return `${existsSync(node) ? `"${node}"` : "node"} "${join(root, "dist", "cli.js")}" update`;
}

// ---- where releases come from

export interface UpdateSource {
  latest(): Promise<unknown>;
  fetchAsset(entry: PlatformEntry, dest: string): Promise<void>;
}

/** A folder holding latest.json and the archives (offline installs, tests). */
export function dirSource(dir: string): UpdateSource {
  return {
    latest: async () => JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as unknown,
    fetchAsset: (entry, dest) => copyFile(join(dir, basename(entry.file)), dest),
  };
}

/** GitHub Releases (or any server laid out the same way). Asset URLs must stay under `assetPrefix`. */
export function httpSource(base = LATEST_BASE, assetPrefix = ASSET_PREFIX): UpdateSource {
  const headers = { "user-agent": `${APP}-updater` };
  return {
    async latest() {
      const res = await fetch(`${base}/latest.json`, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) {
        throw new Error(`There is no latest.json to read at ${base} yet (releases before 0.6 do not publish one). Download the full package: ${FULL_DOWNLOAD}`);
      }
      if (!res.ok) throw new Error(`Could not read latest.json (HTTP ${res.status}).`);
      return (await res.json()) as unknown;
    },
    async fetchAsset(entry, dest) {
      if (!entry.url.startsWith(assetPrefix)) throw new Error(`Refusing to download from ${entry.url}: it is outside ${assetPrefix}`);
      const res = await fetch(entry.url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    },
  };
}

/** `--source`: a folder, or an http(s) address laid out like the releases. Default: GitHub Releases. */
export function sourceFrom(spec?: string): UpdateSource {
  if (!spec) return httpSource();
  if (/^https?:\/\//i.test(spec)) {
    const base = spec.replace(/\/+$/, "");
    return httpSource(base, `${base}/`);
  }
  return dirSource(resolve(spec));
}

// ---- check

export interface UpdateOptions {
  /** The install to update. Default: the folder this code runs from. */
  root?: string;
  source?: UpdateSource;
  /** Default: this machine, e.g. linux-x64. */
  platform?: string;
}

export interface CheckResult {
  status: "up-to-date" | "available" | "blocked";
  current: string;
  latest: string;
  /** Why an update cannot be applied (blocked only). */
  reason?: string;
  /** The full package, for when a small update is not enough. */
  fullDownload: string;
}

interface Resolved {
  result: CheckResult;
  latest: Latest;
  entry?: PlatformEntry;
}

async function resolveUpdate(o: UpdateOptions): Promise<Resolved> {
  const root = o.root ?? packageRoot();
  const source = o.source ?? httpSource();
  const key = o.platform ?? platformKey(process.platform, process.arch);
  const current = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const latest = parseLatest(await source.latest());
  const base = { current, latest: latest.version, fullDownload: FULL_DOWNLOAD };
  const blocked = (reason: string): Resolved => ({ result: { status: "blocked", reason, ...base }, latest });

  if (compareVersions(latest.version, current) <= 0) return { result: { status: "up-to-date", ...base }, latest };
  if (existsSync(join(root, ".git")) || existsSync(join(root, "src"))) {
    return blocked("This is a developer checkout: update it with git pull and pnpm build.");
  }
  const entry = pickPlatform(latest, key);
  if (!entry) return blocked(`This release has no app update for ${key}. Download the full package.`);
  const runtime = readRuntime(root);
  if (!runtime) {
    return blocked("This install was made before updates existed. Install the full package once; later versions can be updated with this command.");
  }
  if (runtime !== entry.runtime) {
    return blocked("The dependencies or the runtime (Node, ffmpeg tools) changed in this release, so a small update is not enough. Download the full package.");
  }
  return { result: { status: "available", ...base }, latest, entry };
}

export async function checkForUpdate(o: UpdateOptions = {}): Promise<CheckResult> {
  return (await resolveUpdate(o)).result;
}

// ---- apply

export interface ApplyOptions extends UpdateOptions {
  /** The copy of the skill that setup made for Claude Code. Default: ~/.claude/skills/<app>; null leaves it alone. */
  skillDir?: string | null;
  log?: (msg: string) => void;
  /** Test hooks. */
  hooks?: { afterReplace?: (item: string) => void };
}

export interface ApplyResult {
  from: string;
  to: string;
  /** Where the replaced files were kept (for a manual rollback). */
  backup: string;
  /** The Claude Code skill copy was refreshed. */
  skill: boolean;
  restart: "Restart your AI apps so they start the new version.";
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Reject anything that is not plain app files: other folders, `..`, absolute paths, links. */
async function checkArchive(archive: string): Promise<void> {
  const names = (await run(tarBin(), ["-tzf", archive])).stdout.split(/\r?\n/).filter(Boolean);
  for (const raw of names) {
    const name = raw.replace(/^\.\//, "").replace(/\\/g, "/");
    const parts = name.split("/").filter(Boolean);
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || parts.includes("..") || !APP_ITEMS.includes(parts[0] ?? "")) {
      throw new Error(`The update contains a file outside the app files: ${raw}`);
    }
  }
  const verbose = (await run(tarBin(), ["-tvzf", archive])).stdout.split(/\r?\n/).filter(Boolean);
  const link = verbose.find((l) => l.startsWith("l") || l.startsWith("h"));
  if (link) throw new Error(`The update contains a link, which is not allowed: ${link}`);
}

const retry = { recursive: true, force: true, maxRetries: 5, retryDelay: 300 };

export async function applyUpdate(o: ApplyOptions = {}): Promise<ApplyResult> {
  const log = o.log ?? (() => {});
  const root = o.root ?? packageRoot();
  const { result, latest, entry } = await resolveUpdate(o);
  if (result.status === "up-to-date") throw new Error(`Already up to date (${result.current}).`);
  if (result.status === "blocked" || !entry) throw new Error(`${result.reason} ${result.fullDownload}`);
  const source = o.source ?? httpSource();
  const skillDir = o.skillDir === undefined ? join(homedir(), ".claude", "skills", APP) : o.skillDir;

  const tmp = join(root, ".update-tmp");
  rmSync(tmp, retry);
  mkdirSync(tmp, { recursive: true });
  try {
    // 1. Download and check everything before touching the install.
    const archive = join(tmp, "app.tar.gz");
    log(`downloading ${entry.file} (${result.current} -> ${latest.version})`);
    await source.fetchAsset(entry, archive);
    if ((await sha256File(archive)) !== entry.sha256) throw new Error("The SHA-256 of the download does not match latest.json. Nothing was changed.");
    await checkArchive(archive);
    const fresh = join(tmp, "new");
    mkdirSync(fresh);
    await run(tarBin(), ["-xzf", archive, "-C", fresh]);
    for (const must of ["dist/mcp.js", "dist/cli.js", "package.json"]) {
      if (!existsSync(join(fresh, must))) throw new Error(`The update is incomplete: ${must} is missing. Nothing was changed.`);
    }
    const version = (JSON.parse(readFileSync(join(fresh, "package.json"), "utf8")) as { version?: string }).version;
    if (version !== latest.version) throw new Error(`The update says it is version ${version} but latest.json says ${latest.version}. Nothing was changed.`);
    if (readRuntime(fresh) !== entry.runtime) throw new Error("The update was built for another runtime. Nothing was changed.");

    // 2. Keep what is replaced (the latest backup only).
    const backups = join(root, ".update-backup");
    const backup = join(backups, result.current);
    rmSync(backup, retry);
    mkdirSync(backup, { recursive: true });
    for (const item of APP_ITEMS) if (existsSync(join(root, item))) cpSync(join(root, item), join(backup, item), { recursive: true });

    // 3. Swap. Any failure puts the old files back.
    log("replacing the app files");
    try {
      for (const item of APP_ITEMS) {
        if (!existsSync(join(fresh, item))) continue;
        rmSync(join(root, item), retry);
        cpSync(join(fresh, item), join(root, item), { recursive: true });
        o.hooks?.afterReplace?.(item);
      }
    } catch (err) {
      for (const item of APP_ITEMS) {
        rmSync(join(root, item), retry);
        if (existsSync(join(backup, item))) cpSync(join(backup, item), join(root, item), { recursive: true });
      }
      const code = (err as NodeJS.ErrnoException).code;
      const hint = code === "EBUSY" || code === "EPERM" ? " A file is in use: close your AI apps and run the update again." : "";
      throw new Error(`The update failed and was rolled back: ${(err as Error).message}.${hint}`);
    }
    for (const old of readdirSync(backups)) if (old !== result.current) rmSync(join(backups, old), retry);

    // 4. The copy of the skill that setup made for Claude Code.
    let skill = false;
    if (skillDir && existsSync(skillDir) && existsSync(join(root, "skill"))) {
      try {
        rmSync(skillDir, retry);
        cpSync(join(root, "skill"), skillDir, { recursive: true });
        skill = true;
      } catch (err) {
        log(`could not refresh ${skillDir}: ${(err as Error).message}`);
      }
    }
    return { from: result.current, to: latest.version, backup, skill, restart: "Restart your AI apps so they start the new version." };
  } finally {
    rmSync(tmp, retry);
  }
}
