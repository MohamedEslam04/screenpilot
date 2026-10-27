import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP, APP_TITLE, OUTPUT_ENV } from "../brand.js";
import { CLIENTS, type ClientSpec, type PathEnv, type ServerLaunch, stillValid } from "./clients.js";

// One-step install for people who never open a terminal: put the app in a
// stable place and register its MCP server with every AI tool on this
// computer (Claude Desktop/Code, Codex, OpenCode, Cursor, Gemini CLI,
// Windsurf, VS Code). Each config file is backed up before it is changed.

export interface SetupOptions {
  /** Only these client ids (default: every one that is installed). */
  clients?: string[];
  remove?: boolean;
  outputDir?: string;
  /** Use the package where it is instead of copying it to the app folder. */
  inPlace?: boolean;
  log?: (m: string) => void;
}

export interface SetupRow {
  client: string;
  status: "added" | "removed" | "not installed" | "not configured" | "failed";
  detail: string;
}

export interface SetupReport {
  appDir: string;
  outputDir: string;
  rows: SetupRow[];
}

/** The package folder this code runs from (dist/ is one level down). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function pathEnv(): PathEnv {
  const home = homedir();
  const appData = process.platform === "win32" ? (process.env.APPDATA ?? join(home, "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return { home, platform: process.platform, appData, codexHome: process.env.CODEX_HOME || undefined };
}

/** Where the app lives once installed. */
export function appHome(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_TITLE);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), APP);
}

export async function setup(opts: SetupOptions = {}): Promise<SetupReport> {
  const log = opts.log ?? (() => {});
  const src = packageRoot();
  const devCheckout = existsSync(join(src, ".git")) || existsSync(join(src, "src"));
  let dir = src;
  if (!opts.remove && !opts.inPlace && !devCheckout && resolve(src) !== resolve(appHome())) {
    dir = appHome();
    log(`installing to ${dir}`);
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      cpSync(src, dir, { recursive: true });
    } catch (err) {
      // Windows locks files of a running server: an AI app still has the old copy open.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM") throw new Error(`${dir} is in use. Close your AI apps (Claude, Cursor, …) and run setup again.`);
      throw err;
    }
  }

  const outputDir = opts.outputDir ?? join(homedir(), "Videos", APP_TITLE);
  if (!opts.remove) mkdirSync(outputDir, { recursive: true });
  const bundledNode = join(dir, "bin", process.platform === "win32" ? "node.exe" : "node");
  const launch: ServerLaunch = {
    command: existsSync(bundledNode) ? bundledNode : process.execPath,
    args: [join(dir, "dist", "mcp.js")],
    env: { [OUTPUT_ENV]: outputDir },
  };

  const env = pathEnv();
  const rows: SetupRow[] = [];
  for (const spec of CLIENTS) {
    if (opts.clients && !opts.clients.includes(spec.id)) continue;
    rows.push(configure(spec, env, launch, !!opts.remove, !!opts.clients));
  }
  if (!opts.clients || opts.clients.includes("claude-code")) rows.push(claudeCode(launch, dir, !!opts.remove));
  return { appDir: dir, outputDir, rows };
}

function configure(spec: ClientSpec, env: PathEnv, launch: ServerLaunch, remove: boolean, asked: boolean): SetupRow {
  const primary = spec.file(env);
  const file = existsSync(primary) ? primary : (spec.alternates?.(env).find((f) => existsSync(f)) ?? primary);
  if (!existsSync(spec.marker(env)) && !asked) return { client: spec.title, status: "not installed", detail: "" };
  try {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (remove && !before.includes(APP)) return { client: spec.title, status: "not configured", detail: file };
    const after = spec.apply(before, APP, remove ? undefined : launch);
    if (!stillValid(spec, after)) throw new Error("the updated file would not parse; left unchanged");
    if (before) copyFileSync(file, `${file}.${APP}-backup`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    return { client: spec.title, status: remove ? "removed" : "added", detail: file };
  } catch (err) {
    return { client: spec.title, status: "failed", detail: `${file}: ${(err as Error).message}` };
  }
}

/** Claude Code keeps MCP servers in its own store: use its CLI when it is installed. */
function claudeCode(launch: ServerLaunch, dir: string, remove: boolean): SetupRow {
  const shell = process.platform === "win32";
  const has = spawnSync("claude", ["--version"], { shell, stdio: "ignore" }).status === 0;
  if (!has) return { client: "Claude Code", status: "not installed", detail: "" };
  spawnSync("claude", ["mcp", "remove", "--scope", "user", APP], { shell, stdio: "ignore" });
  if (remove) {
    rmSync(join(homedir(), ".claude", "skills", APP), { recursive: true, force: true });
    return { client: "Claude Code", status: "removed", detail: "user scope" };
  }
  const envArgs = Object.entries(launch.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = spawnSync("claude", ["mcp", "add", "--scope", "user", ...envArgs, APP, "--", launch.command, ...launch.args], { shell, encoding: "utf8" });
  if (r.status !== 0) return { client: "Claude Code", status: "failed", detail: (r.stderr || r.stdout || "").trim().slice(0, 200) };
  // The skill teaches Claude the record → storyboard → render workflow.
  const skill = join(dir, "skill");
  if (existsSync(skill)) {
    const dest = join(homedir(), ".claude", "skills", APP);
    rmSync(dest, { recursive: true, force: true });
    cpSync(skill, dest, { recursive: true });
  }
  return { client: "Claude Code", status: "added", detail: "user scope (+ skill)" };
}
