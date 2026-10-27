// Package ScreenPilot for people who never open a terminal.
//
//   pnpm package [--ffmpeg-dir <folder with ffmpeg + ffprobe>]
//
// Builds for the OS it runs on (native modules are per-OS, so CI builds each
// platform on its own runner):
//   windows → release/ScreenPilot-<version>-windows.zip   ("ScreenPilot Setup.cmd" adds it to every AI tool)
//             release/ScreenPilot-<version>-windows.mcpb  (double-click in Claude Desktop)
//   linux   → release/ScreenPilot-<version>-linux.tar.gz  (install.sh adds it to every AI tool)
// The zip/tarball carry their own Node, so nothing else needs installing.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP, APP_TITLE, OUTPUT_ENV } from "../src/brand.js";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; description: string };
// PACKAGE_AS=windows lets a Linux box check the .mcpb manifest/packing (its native modules would be Linux ones: test only).
const platform = process.env.PACKAGE_AS ?? (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : process.platform);
const ffmpegDir = argValue("--ffmpeg-dir");
const out = join(root, "release");
// The archive's top folder is the stage folder itself.
const stage = join(out, `stage-${platform}`, APP_TITLE);
const exe = process.platform === "win32" ? ".exe" : "";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sh(cmd: string, args: string[], cwd = root): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} → exit ${c}`))));
  });
}

/** Tool names + descriptions straight from the built server (tools/list over stdio). */
async function listTools(entry: string): Promise<{ name: string; description: string }[]> {
  const p = spawn(process.execPath, [entry], { cwd: stage, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map<number, (m: { result?: { tools?: { name: string; description?: string }[] } }) => void>();
  p.stdout.on("data", (d: Buffer) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number };
      if (msg.id !== undefined) waiting.get(msg.id)?.(msg as never);
    }
  });
  const rpc = (id: number, method: string, params: unknown) =>
    new Promise<{ result?: { tools?: { name: string; description?: string }[] } }>((r) => {
      waiting.set(id, r);
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-mcpb", version: "0" } });
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const r = await rpc(2, "tools/list", {});
  p.kill();
  // The manifest shows a short line per tool: keep the first sentence.
  return (r.result?.tools ?? []).map((t) => ({ name: t.name, description: (t.description ?? "").split(/(?<=\.)\s/)[0]!.slice(0, 200) }));
}

async function main(): Promise<void> {
  log(`building ${APP_TITLE} ${pkg.version} for ${platform}`);
  await sh("pnpm", ["build"]);

  rmSync(dirname(stage), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(root, "skill"), join(stage, "skill"), { recursive: true });
  copyFileSync(join(root, "assets", "icon.png"), join(stage, "icon.png"));
  for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "README.md"]) copyFileSync(join(root, f), join(stage, f));

  // Production dependencies, flat (no symlinks: zip archives and Windows don't love them).
  await sh("pnpm", ["install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"], stage);
  for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) rmSync(join(stage, f), { force: true });

  if (ffmpegDir) {
    mkdirSync(join(stage, "bin"), { recursive: true });
    for (const tool of ["ffmpeg", "ffprobe"]) copyFileSync(join(ffmpegDir, `${tool}${exe}`), join(stage, "bin", `${tool}${exe}`));
    log(`bundled ffmpeg from ${ffmpegDir}`);
  } else {
    log("no --ffmpeg-dir: the package will use ffmpeg from PATH");
  }

  const tools = await listTools(join(stage, "dist", "mcp.js"));
  log(`${tools.length} tools`);
  mkdirSync(out, { recursive: true });

  if (platform === "windows") {
    const manifest = {
      manifest_version: "0.3",
      name: APP,
      display_name: APP_TITLE,
      version: pkg.version,
      description: pkg.description,
      long_description:
        `${APP_TITLE} lets Claude make screen videos for you. Ask it to record your screen while you work, or to operate ` +
        "your apps and websites itself, then it edits the footage into a polished MP4 with zooms, captions and an AI voiceover " +
        "(English, Arabic and more). Everything runs on your computer; no OBS or other recorder needed.",
      author: { name: "Mohamed Eslam", url: "https://github.com/MohamedEslam04" },
      repository: { type: "git", url: "https://github.com/MohamedEslam04/screenpilot" },
      homepage: "https://github.com/MohamedEslam04/screenpilot",
      icon: "icon.png",
      license: "MIT",
      keywords: ["screen recording", "video", "demo", "tutorial", "voiceover", "captions"],
      server: {
        type: "node",
        entry_point: "dist/mcp.js",
        mcp_config: {
          command: "node",
          args: ["${__dirname}/dist/mcp.js"],
          env: { [OUTPUT_ENV]: "${user_config.output_dir}" },
        },
      },
      user_config: {
        output_dir: {
          type: "directory",
          title: "Save videos to",
          description: "Folder for your recordings and finished videos.",
          default: "${HOME}/Videos/ScreenPilot",
          required: false,
        },
      },
      tools,
      compatibility: { platforms: ["win32"], runtimes: { node: ">=22.0.0" } },
    };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const file = join(out, `${APP_TITLE}-${pkg.version}-windows.mcpb`);
    await sh("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "validate", join(stage, "manifest.json")]);
    await sh("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "pack", stage, file]);
    log(`→ ${file}`);
    rmSync(join(stage, "manifest.json"));

    // Claude Desktop brings its own Node for the .mcpb; the zip is for every other tool.
    bundleNode();
    const setupCmd = (args: string, done: string) =>
      [
        "@echo off",
        'cd /d "%~dp0"',
        `"bin\\node.exe" "dist\\cli.js" setup${args} > nul`,
        "echo.",
        `echo ${done}`,
        "pause",
        "",
      ].join("\r\n");
    writeFileSync(join(stage, `${APP_TITLE} Setup.cmd`), setupCmd("", "You can close this window."));
    writeFileSync(join(stage, `Uninstall ${APP_TITLE}.cmd`), setupCmd(" --remove", `${APP_TITLE} was removed from your AI tools.`));
    const zip = join(out, `${APP_TITLE}-${pkg.version}-windows.zip`);
    rmSync(zip, { force: true });
    if (process.platform === "win32") {
      // Windows' own bsdtar (not Git's GNU tar) writes a zip for -a + .zip.
      await sh(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", zip, "-C", dirname(stage), APP_TITLE]);
    } else {
      await sh("zip", ["-qr", zip, APP_TITLE], dirname(stage));
    }
    log(`→ ${zip}`);
  } else {
    bundleNode();
    const script = (args: string, what: string) => `#!/usr/bin/env bash
# ${what}
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/bin/node" "$DIR/dist/cli.js" setup${args} "$@" >/dev/null
`;
    writeFileSync(join(stage, "install.sh"), script("", `Adds ${APP_TITLE} to every AI tool on this computer. Usage: ./install.sh [--output <videos folder>]`));
    writeFileSync(join(stage, "uninstall.sh"), script(" --remove", `Removes ${APP_TITLE} from your AI tools.`));
    for (const f of ["install.sh", "uninstall.sh"]) chmodSync(join(stage, f), 0o755);
    const file = join(out, `${APP_TITLE}-${pkg.version}-linux.tar.gz`);
    await sh("tar", ["-czf", file, "-C", dirname(stage), APP_TITLE]);
    log(`→ ${file}`);
  }
}

/** Ship the Node that built the package (its native modules match it). */
function bundleNode(): void {
  mkdirSync(join(stage, "bin"), { recursive: true });
  const dest = join(stage, "bin", `node${exe}`);
  copyFileSync(process.execPath, dest);
  chmodSync(dest, 0o755);
  log(`bundled node ${process.version}`);
}

function log(m: string): void {
  process.stderr.write(`package: ${m}\n`);
}

await main();
if (!existsSync(out)) process.exit(1);
