import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { APP, APP_TITLE, OUTPUT_ENV } from "../brand.js";
import { CLIENTS, type ClientSpec, claudeAllowRule, NEVER, type PathEnv, type ServerLaunch, stillValid } from "./clients.js";
import { defaultOutputDir } from "./folders.js";
import { type PrepareResult, prepareRenderer } from "./prepare.js";

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
  /** Skip downloading the render browser and the test render. */
  skipPrepare?: boolean;
  /** Claude Code: allow every screenpilot tool without a prompt each time (permissions.allow in ~/.claude/settings.json). */
  allowTools?: boolean;
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
  /** Render browser + test render (absent when removing or skipped). */
  renderer?: PrepareResult;
}

/** The package folder this code runs from (dist/ is one level down). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function pathEnv(): PathEnv {
  const home = homedir();
  const appData =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    home,
    platform: process.platform,
    appData,
    codexHome: process.env.CODEX_HOME || undefined,
    copilotHome: process.env.COPILOT_HOME || undefined,
    claudeStoreDir: claudeStoreDir(),
  };
}

/** Settings folder of Claude Desktop installed from the Microsoft Store (MSIX), if any. */
function claudeStoreDir(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const packages = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Packages");
  try {
    const pkg = readdirSync(packages).find((d) => /^Claude_/i.test(d));
    return pkg ? join(packages, pkg, "LocalCache", "Roaming", "Claude") : undefined;
  } catch {
    return undefined;
  }
}

/** Where the app lives once installed. */
export function appHome(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_TITLE);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP_TITLE);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), APP);
}

export async function setup(opts: SetupOptions = {}): Promise<SetupReport> {
  const log = opts.log ?? (() => {});
  // `sudo ./install.sh` would set it up for root, not for the person at the desktop.
  if (process.platform !== "win32" && process.getuid?.() === 0 && process.env.SUDO_USER) {
    throw new Error(`Run setup without sudo (as ${process.env.SUDO_USER}): it installs for your user only and needs no admin rights.`);
  }
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

  const outputDir = resolve(opts.outputDir ?? defaultOutputDir());
  if (!opts.remove) mkdirSync(outputDir, { recursive: true });
  const launch = serverLaunch(dir, outputDir);

  const env = pathEnv();
  const rows: SetupRow[] = [];
  for (const spec of CLIENTS) {
    if (opts.clients && !opts.clients.includes(spec.id)) continue;
    rows.push(configure(spec, env, launch, !!opts.remove, !!opts.clients));
  }
  if (!opts.clients || opts.clients.includes("claude-code")) rows.push(claudeCode(launch, dir, !!opts.remove, !!opts.allowTools));
  const renderer = opts.remove || opts.skipPrepare ? undefined : await prepareRenderer(log);
  return { appDir: dir, outputDir, rows, renderer };
}

/** Every client setup can configure, with its config file and whether it's installed here. */
export function knownClients(): { id: string; title: string; installed: boolean; file: string }[] {
  const env = pathEnv();
  return [
    ...CLIENTS.map((c) => ({ id: c.id, title: c.title, installed: existsSync(c.marker(env)), file: c.file(env) })),
    { id: "claude-code", title: "Claude Code", installed: claudeAvailable(), file: "claude mcp (user scope)" },
  ];
}

/** How an AI client starts the server installed in `dir`. */
export function serverLaunch(dir: string, outputDir: string): ServerLaunch {
  const bundledNode = join(dir, "bin", process.platform === "win32" ? "node.exe" : "node");
  return {
    command: existsSync(bundledNode) ? bundledNode : process.execPath,
    args: [join(dir, "dist", "mcp.js")],
    env: { [OUTPUT_ENV]: outputDir },
  };
}

/** Config to paste by hand into an AI tool setup doesn't know (the common `mcpServers` shape). */
export function manualConfig(outputDir = defaultOutputDir()): { mcpServers: Record<string, ServerLaunch> } {
  const dir = existsSync(appHome()) ? appHome() : packageRoot();
  return { mcpServers: { [APP]: serverLaunch(dir, resolve(outputDir)) } };
}

function configure(spec: ClientSpec, env: PathEnv, launch: ServerLaunch, remove: boolean, asked: boolean): SetupRow {
  const primary = spec.file(env);
  const file = existsSync(primary) ? primary : (spec.alternates?.(env).find((f) => existsSync(f)) ?? primary);
  const marker = spec.marker(env);
  if (!existsSync(marker) && (!asked || marker === NEVER)) return { client: spec.title, status: "not installed", detail: "" };
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

/** The `claude` CLI: on Windows a .exe runs without a shell (so paths with spaces survive); an npm .cmd shim needs one. */
function claudeCli(): { file: string; shell: boolean } | undefined {
  if (process.platform !== "win32") return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0 ? { file: "claude", shell: false } : undefined;
  const where = spawnSync("where", ["claude"], { encoding: "utf8", windowsHide: true });
  const found = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return { file: exe, shell: false };
  const cmd = found.find((f) => /\.(cmd|bat)$/i.test(f));
  return cmd ? { file: cmd, shell: true } : undefined;
}

function runClaude(cli: { file: string; shell: boolean }, args: string[]) {
  // Through cmd.exe every argument with spaces must be quoted by us.
  const argv = cli.shell ? args.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)) : args;
  return spawnSync(cli.shell ? `"${cli.file}"` : cli.file, argv, { shell: cli.shell, encoding: "utf8", windowsHide: true });
}

function claudeAvailable(): boolean {
  return claudeCli() !== undefined;
}

/** Claude Code keeps MCP servers in its own store: use its CLI when it is installed. */
function claudeCode(launch: ServerLaunch, dir: string, remove: boolean, allowTools: boolean): SetupRow {
  const cli = claudeCli();
  if (!cli) return { client: "Claude Code", status: "not installed", detail: "" };
  runClaude(cli, ["mcp", "remove", "--scope", "user", APP]);
  if (remove) {
    rmSync(join(homedir(), ".claude", "skills", APP), { recursive: true, force: true });
    allowRule(true);
    return { client: "Claude Code", status: "removed", detail: "user scope" };
  }
  // The name goes before -e: -e takes several values and would swallow it ("Invalid environment
  // variable format: screenpilot"); "--" ends -e and starts the server command.
  const envArgs = Object.entries(launch.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = runClaude(cli, ["mcp", "add", "--scope", "user", APP, ...envArgs, "--", launch.command, ...launch.args]);
  if (r.status !== 0) return { client: "Claude Code", status: "failed", detail: (r.stderr || r.stdout || "").trim().slice(0, 200) };
  // The skill teaches Claude the record → storyboard → render workflow.
  const skill = join(dir, "skill");
  if (existsSync(skill)) {
    const dest = join(homedir(), ".claude", "skills", APP);
    rmSync(dest, { recursive: true, force: true });
    cpSync(skill, dest, { recursive: true });
  }
  if (allowTools) {
    const err = allowRule(false);
    if (err) return { client: "Claude Code", status: "failed", detail: `added, but could not allow its tools: ${err}` };
  }
  return { client: "Claude Code", status: "added", detail: `user scope (+ skill${allowTools ? ", tools allowed without prompts" : ""})` };
}

/** Add/remove the "allow every tool of this server" rule in Claude Code's settings. Returns an error message, or undefined. */
function allowRule(remove: boolean): string | undefined {
  const file = join(homedir(), ".claude", "settings.json");
  try {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (remove && !before.includes(`mcp__${APP}`)) return undefined;
    const after = claudeAllowRule(before, `mcp__${APP}`, remove);
    if (after === before) return undefined;
    const errors: { error: number }[] = [];
    parse(after, errors as never, { allowTrailingComma: true });
    if (errors.length) throw new Error("the updated file would not parse; left unchanged");
    if (before) copyFileSync(file, `${file}.${APP}-backup`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    return undefined;
  } catch (err) {
    return `${file}: ${(err as Error).message}`;
  }
}
