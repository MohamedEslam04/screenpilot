import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { CLIENTS, jsonSet, stillValid, tomlServer } from "../src/setup/clients.js";

const launch = { command: "C:\\SP\\bin\\node.exe", args: ["C:\\SP\\dist\\mcp.js"], env: { SCREENPILOT_OUTPUT: "C:\\Users\\a\\Videos\\ScreenPilot" } };
const spec = (id: string) => CLIENTS.find((c) => c.id === id)!;
const env = { home: "/home/u", platform: "linux" as const, appData: "/home/u/.config" };

describe("JSON clients", () => {
  it("adds to Claude Desktop without touching other servers", () => {
    const before = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }, null, 2);
    const after = JSON.parse(spec("claude-desktop").apply(before, "screenpilot", launch));
    expect(after.mcpServers.other).toEqual({ command: "x" });
    expect(after.mcpServers.screenpilot).toEqual(launch);
    expect(after.theme).toBe("dark");
  });

  it("writes OpenCode's local shape and keeps comments in JSONC", () => {
    const before = '{\n  // my settings\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    const text = spec("opencode").apply(before, "screenpilot", launch);
    expect(text).toContain("// my settings");
    const mcp = (JSON.parse(text.replace(/\/\/.*\n/, "")) as { mcp: Record<string, unknown> }).mcp.screenpilot;
    expect(mcp).toEqual({ type: "local", command: [launch.command, ...launch.args], enabled: true, environment: launch.env });
  });

  it("follows OpenCode 2.x's mcp.servers layout when the file already uses it", () => {
    const before = '{\n  // v2\n  "mcp": { "servers": { "other": { "type": "local", "command": ["x"] } } },\n}\n';
    const text = spec("opencode").apply(before, "screenpilot", launch);
    expect(text).toContain("// v2");
    const mcp = (parse(text) as { mcp: { servers: Record<string, unknown> } }).mcp;
    expect(Object.keys(mcp)).toEqual(["servers"]);
    expect(mcp.servers.screenpilot).toEqual({ type: "local", command: [launch.command, ...launch.args], disabled: false, environment: launch.env });
    expect(mcp.servers.other).toBeDefined();
  });

  it("moves an OpenCode entry between layouts instead of duplicating it", () => {
    const v1 = spec("opencode").apply("", "screenpilot", launch);
    const both = jsonSet(v1, ["mcp", "servers", "other"], { type: "local", command: ["x"] });
    const mcp = (parse(spec("opencode").apply(both, "screenpilot", launch)) as { mcp: Record<string, Record<string, unknown>> }).mcp;
    expect(mcp.screenpilot).toBeUndefined();
    expect(mcp.servers!.screenpilot).toBeDefined();
    const removed = parse(spec("opencode").apply(both, "screenpilot", undefined)) as { mcp: Record<string, Record<string, unknown>> };
    expect(JSON.stringify(removed)).not.toContain("screenpilot");
  });

  it("uses VS Code's servers/stdio shape", () => {
    const after = JSON.parse(spec("vscode").apply("", "screenpilot", launch));
    expect(after.servers.screenpilot).toEqual({ type: "stdio", command: launch.command, args: launch.args, env: launch.env });
  });

  it("removes only our entry", () => {
    const before = spec("cursor").apply('{"mcpServers":{"keep":{"command":"k"}}}', "screenpilot", launch);
    const after = JSON.parse(spec("cursor").apply(before, "screenpilot", undefined));
    expect(after.mcpServers).toEqual({ keep: { command: "k" } });
  });

  it("creates the file content when there is none", () => {
    expect(JSON.parse(jsonSet("", ["mcpServers", "a"], { command: "c" }))).toEqual({ mcpServers: { a: { command: "c" } } });
  });

  it("resolves per-OS config paths", () => {
    expect(spec("opencode").file(env)).toBe("/home/u/.config/opencode/opencode.json");
    expect(spec("opencode").file({ home: "C:/Users/u", platform: "win32", appData: "C:/Users/u/AppData/Roaming" })).toBe("C:/Users/u/.config/opencode/opencode.json");
    expect(spec("codex").file(env)).toBe("/home/u/.codex/config.toml");
    expect(spec("codex").file({ ...env, codexHome: "/x/codex" })).toBe("/x/codex/config.toml");
    expect(spec("claude-desktop").file({ ...env, appData: "C:/Users/u/AppData/Roaming" })).toBe("C:/Users/u/AppData/Roaming/Claude/claude_desktop_config.json");
  });
});

describe("Codex config.toml", () => {
  const before = `model = "gpt-5"
# keep this comment

[mcp_servers.other]
command = "npx"
args = ["-y", "other"]

[mcp_servers.screenpilot]
command = "old"

[mcp_servers.screenpilot.env]
A = "1"

[profiles.fast]
model = "mini"
`;

  it("replaces our table (and its sub-tables) and keeps everything else", () => {
    const out = tomlServer(before, "screenpilot", launch);
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain("# keep this comment");
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("[profiles.fast]");
    expect(out).not.toContain('command = "old"');
    expect(out).not.toContain("[mcp_servers.screenpilot.env]");
    expect(out).toContain(`[mcp_servers.screenpilot]\ncommand = "C:\\\\SP\\\\bin\\\\node.exe"`);
    expect(out).toContain('env = { "SCREENPILOT_OUTPUT" = "C:\\\\Users\\\\a\\\\Videos\\\\ScreenPilot" }');
    expect(out.match(/\[mcp_servers\.screenpilot\]/g)).toHaveLength(1);
  });

  it("removes our table", () => {
    const out = tomlServer(before, "screenpilot", undefined);
    expect(out).not.toContain("screenpilot");
    expect(out).toContain("[profiles.fast]");
  });

  it("starts a fresh file", () => {
    expect(tomlServer("", "screenpilot", launch).startsWith("[mcp_servers.screenpilot]\n")).toBe(true);
  });
});

describe("stillValid", () => {
  it("rejects broken JSON", () => {
    expect(stillValid(spec("cursor"), "{ broken")).toBe(false);
    expect(stillValid(spec("cursor"), '{"a": 1,}')).toBe(true); // trailing comma tolerated (JSONC)
  });
});
