// Assert Codex / OpenCode configs under a (fake) home do or don't list screenpilot.
//   node scripts/ci/assert-registered.mjs <home> present|absent
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [home, mode] = process.argv.slice(2);
if (!home || !["present", "absent"].includes(mode)) throw new Error("usage: assert-registered.mjs <home> present|absent");
const want = mode === "present";
let ok = true;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  ok = false;
};

// Codex: [mcp_servers.screenpilot] command = "..."
const toml = join(home, ".codex", "config.toml");
const text = existsSync(toml) ? readFileSync(toml, "utf8") : "";
const section = text.split(/^\[/m).find((s) => s.startsWith("mcp_servers.screenpilot]"));
if (want) {
  const cmd = section && /^command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(section)?.[1];
  if (!cmd) fail(`no screenpilot entry in ${toml}`);
  else {
    const path = JSON.parse(`"${cmd}"`);
    if (!existsSync(path)) fail(`Codex command does not exist: ${path}`);
    else console.log(`codex ok: ${path}`);
  }
} else if (section || text.includes("screenpilot")) fail(`${toml} still mentions screenpilot`);
else console.log("codex entry gone");

// OpenCode: mcp.screenpilot.command = [exe, ...args]
const json = join(home, ".config", "opencode", "opencode.json");
const entry = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")).mcp?.screenpilot : undefined;
if (want) {
  const cmd = Array.isArray(entry?.command) ? entry.command : undefined;
  if (!cmd) fail(`no screenpilot entry in ${json}`);
  else for (const p of cmd.filter((x) => /[\\/]/.test(x))) existsSync(p) ? console.log(`opencode ok: ${p}`) : fail(`OpenCode path does not exist: ${p}`);
} else if (entry) fail(`${json} still has screenpilot`);
else console.log("opencode entry gone");

process.exit(ok ? 0 : 1);
