// Package ScreenPilot for people who never open a terminal.
//
//   pnpm package [--ffmpeg-dir <folder with ffmpeg + ffprobe>]
//
// Builds for the OS it runs on (native modules are per-OS, so CI builds each
// platform on its own runner):
//   windows → release/ScreenPilot-<version>-windows.mcpb  (double-click in Claude Desktop)
//   linux   → release/ScreenPilot-<version>-linux.tar.gz  (install.sh registers it with Claude Code)

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP, APP_TITLE, OUTPUT_ENV } from "../src/brand.js";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; description: string };
// PACKAGE_AS=windows lets a Linux box check the .mcpb manifest/packing (its native modules would be Linux ones: test only).
const platform = process.env.PACKAGE_AS ?? (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : process.platform);
const ffmpegDir = argValue("--ffmpeg-dir");
const out = join(root, "release");
const stage = join(out, `stage-${platform}`);
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

  rmSync(stage, { recursive: true, force: true });
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
  } else {
    // No Claude Desktop on Linux: register the server with Claude Code instead.
    const install = `#!/usr/bin/env bash
# Installs ${APP_TITLE} for Claude Code. Usage: ./install.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="\${${OUTPUT_ENV}:-$HOME/Videos/${APP_TITLE}}"
mkdir -p "$OUT"
command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code is required: https://claude.com/claude-code"; exit 1; }
claude mcp remove --scope user ${APP} >/dev/null 2>&1 || true
claude mcp add --scope user -e ${OUTPUT_ENV}="$OUT" ${APP} -- node "$DIR/dist/mcp.js"
mkdir -p "$HOME/.claude/skills"
rm -rf "$HOME/.claude/skills/${APP}" && cp -r "$DIR/skill" "$HOME/.claude/skills/${APP}"
echo "${APP_TITLE} installed. Videos go to $OUT. Open Claude Code and ask it to record or make a video."
`;
    writeFileSync(join(stage, "install.sh"), install);
    chmodSync(join(stage, "install.sh"), 0o755);
    const file = join(out, `${APP_TITLE}-${pkg.version}-linux.tar.gz`);
    await sh("tar", ["-czf", file, "-C", out, `stage-${platform}`, "--transform", `s,^stage-${platform},${APP},`]);
    log(`→ ${file}`);
  }
}

function log(m: string): void {
  process.stderr.write(`package: ${m}\n`);
}

await main();
if (!existsSync(out)) process.exit(1);
