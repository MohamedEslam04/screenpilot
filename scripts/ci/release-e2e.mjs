// End-to-end check of an INSTALLED release, driven the way an AI app drives it.
//
//   <bundled node> scripts/ci/release-e2e.mjs <opencode.json written by setup>
//
// Reads the server command that setup wrote into the client config, starts it
// over stdio, and as an MCP client: initialize → tools/list → doctor →
// storyboard_init on a test clip → add an Arabic caption + voiceover → render →
// probe the MP4. Uses only Node built-ins (it runs on the release's own Node).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const configPath = process.argv[2];
if (!configPath) throw new Error("usage: release-e2e.mjs <opencode.json>");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const entry = config.mcp?.servers?.screenpilot ?? config.mcp?.screenpilot;
if (!entry?.command?.length) throw new Error(`no screenpilot entry in ${configPath}`);
const [command, ...args] = entry.command;
for (const p of [command, ...args]) if (!existsSync(p)) throw new Error(`configured path does not exist: ${p}`);

const exe = process.platform === "win32" ? ".exe" : "";
const ffmpeg = join(dirname(command), `ffmpeg${exe}`);
const ffprobe = join(dirname(command), `ffprobe${exe}`);
const step = (m) => console.log(`e2e: ${m}`);

const server = spawn(command, args, { env: { ...process.env, ...entry.environment }, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map();
let buf = "";
let nextId = 1;
server.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line); // anything else on stdout would break real clients too
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
  }
});
server.on("exit", (code) => {
  if (waiting.size) {
    console.error(`e2e: server exited (${code}) with requests pending`);
    process.exit(1);
  }
});

function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      waiting.delete(id);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, args, timeoutMs) {
  const r = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const body = r.content?.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`${name} failed: ${body}`);
  return JSON.parse(body);
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-e2e", version: "1" } });
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
if (init.serverInfo?.name !== "screenpilot") throw new Error(`unexpected server ${JSON.stringify(init.serverInfo)}`);
if (!init.instructions) throw new Error("server sent no instructions");
step(`initialize: ${init.serverInfo.title} ${init.serverInfo.version}, instructions ${init.instructions.length} chars`);

const { tools } = await rpc("tools/list", {});
const names = tools.map((t) => t.name);
for (const need of ["record_start", "record_stop", "storyboard_init", "render", "doctor"]) {
  if (!names.includes(need)) throw new Error(`tool ${need} missing (${names.join(", ")})`);
}
step(`tools/list: ${tools.length} tools`);

const doc = await tool("doctor", {}, 120_000);
const bad = doc.checks.filter((c) => ["node", "ffmpeg", "ffprobe", "render browser"].includes(c.name) && !c.ok);
if (bad.length) throw new Error(`doctor: ${JSON.stringify(bad)}`);
step(`doctor: ${doc.summary}`);

const dir = mkdtempSync(join(tmpdir(), "screenpilot-e2e-"));
const video = join(dir, "clip.mp4");
const gen = spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", "-y", video]);
if (gen.status !== 0) throw new Error(`bundled ffmpeg failed: ${gen.stderr}`);

const init2 = await tool("storyboard_init", { target: video, out: join(dir, "storyboard.json"), voice: "ar-EG-SalmaNeural" });
const sb = JSON.parse(readFileSync(init2.storyboard, "utf8"));
sb.captions = [{ at: 0.3, dur: 1.5, text: "ScreenPilot يعمل" }];
sb.narration = [{ at: 1.5, text: "مرحبا، هذا اختبار" }];
writeFileSync(init2.storyboard, JSON.stringify(sb, null, 2));
step(`storyboard_init: ${init2.storyboard}`);

const out = join(dir, "out.mp4");
const r = await tool("render", { storyboard: init2.storyboard, output: out, quality: "draft" }, 600_000);
const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", out], { encoding: "utf8" });
const info = JSON.parse(probe.stdout || "{}");
const duration = Number(info.format?.duration);
const kinds = (info.streams ?? []).map((s) => s.codec_type);
if (!(duration > 3)) throw new Error(`rendered video too short: ${duration}`);
if (!kinds.includes("video") || !kinds.includes("audio")) throw new Error(`expected video + voiceover audio, got ${kinds.join(",")}`);
step(`render: ${r.output} ${duration.toFixed(2)} s, streams ${kinds.join("+")}`);

server.stdin.end();
server.kill();
step("PASS");
process.exit(0);
