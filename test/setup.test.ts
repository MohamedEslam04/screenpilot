import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { CLIENTS, claudeAllowRule, gooseServer, jsonSet, NEVER, stillValid, tomlServer } from "../src/setup/clients.js";

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

describe("more clients", () => {
  const mac = { home: "/Users/u", platform: "darwin" as const, appData: "/Users/u/Library/Application Support" };
  const win = { home: "C:/Users/u", platform: "win32" as const, appData: "C:/Users/u/AppData/Roaming" };

  it("has unique ids", () => {
    const ids = CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves macOS paths", () => {
    expect(spec("claude-desktop").file(mac)).toBe("/Users/u/Library/Application Support/Claude/claude_desktop_config.json");
    expect(spec("vscode").file(mac)).toBe("/Users/u/Library/Application Support/Code/User/mcp.json");
    expect(spec("opencode").file(mac)).toBe("/Users/u/.config/opencode/opencode.json");
    expect(spec("zed").file(mac)).toBe("/Users/u/.config/zed/settings.json");
    expect(spec("goose").file(win)).toBe("C:/Users/u/AppData/Roaming/Block/goose/config/config.yaml");
  });

  it("only targets Claude Desktop (Store) when its package folder exists", () => {
    expect(spec("claude-desktop-store").marker(win)).toBe(NEVER);
    const store = { ...win, claudeStoreDir: "C:/Users/u/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude" };
    expect(spec("claude-desktop-store").file(store)).toBe(`${store.claudeStoreDir}/claude_desktop_config.json`);
  });

  it("detects Cline by its globalStorage folder in each VS Code fork", () => {
    expect(spec("cline-cursor").file(env)).toBe("/home/u/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
    expect(spec("cline-cursor").marker(env)).toBe("/home/u/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev");
  });

  it("writes Zed context_servers and Copilot's local entry", () => {
    expect(JSON.parse(spec("zed").apply("{}", "screenpilot", launch)).context_servers.screenpilot).toEqual(launch);
    const copilot = JSON.parse(spec("copilot").apply("", "screenpilot", launch)).mcpServers.screenpilot;
    expect(copilot).toEqual({ type: "local", ...launch, tools: ["*"] });
  });

  it("edits Goose YAML keeping comments and other extensions", () => {
    const before = "# my goose\nextensions:\n  developer:\n    type: builtin\n    enabled: true\n";
    const text = gooseServer(before, "screenpilot", launch);
    expect(text).toContain("# my goose");
    const doc = parseDocument(text).toJS() as { extensions: Record<string, Record<string, unknown>> };
    expect(doc.extensions.developer).toEqual({ type: "builtin", enabled: true });
    expect(doc.extensions.screenpilot).toMatchObject({ type: "stdio", cmd: launch.command, args: launch.args, envs: launch.env, enabled: true });
    expect(stillValid(spec("goose"), text)).toBe(true);
    const removed = parseDocument(gooseServer(text, "screenpilot", undefined)).toJS() as { extensions: Record<string, unknown> };
    expect(Object.keys(removed.extensions)).toEqual(["developer"]);
  });
});

describe("Claude Code allow rule", () => {
  it("adds the rule, keeping other entries and comments", () => {
    const before = '{\n  // mine\n  "permissions": { "allow": ["Bash(ls)"], "deny": ["Bash(rm *)"] },\n  "theme": "dark"\n}\n';
    const after = claudeAllowRule(before, "mcp__screenpilot", false);
    expect(after).toContain("// mine");
    const doc = parse(after.replace(/\/\/.*\n/, ""));
    expect(doc.permissions.allow).toEqual(["Bash(ls)", "mcp__screenpilot"]);
    expect(doc.permissions.deny).toEqual(["Bash(rm *)"]);
    expect(doc.theme).toBe("dark");
  });

  it("creates permissions from nothing and does not duplicate", () => {
    const once = claudeAllowRule("", "mcp__screenpilot", false);
    expect(JSON.parse(once)).toEqual({ permissions: { allow: ["mcp__screenpilot"] } });
    expect(claudeAllowRule(once, "mcp__screenpilot", false)).toBe(once);
  });

  it("removes only its own rule", () => {
    const before = JSON.stringify({ permissions: { allow: ["Bash(ls)", "mcp__screenpilot"] } });
    expect(JSON.parse(claudeAllowRule(before, "mcp__screenpilot", true)).permissions.allow).toEqual(["Bash(ls)"]);
    expect(claudeAllowRule('{"a":1}', "mcp__screenpilot", true)).toBe('{"a":1}');
  });

  it("keeps the layout: inline stays inline, multi-line stays multi-line, add then remove is exact", () => {
    const inline = '{\n  // keep me\n  "permissions": { "allow": ["Bash(ls)"], "deny": ["Bash(rm *)"] },\n  "theme": "dark"\n}\n';
    const multi = '{\n  "permissions": {\n    "allow": [\n      "Bash(ls)",\n      "Bash(git status)"\n    ]\n  }\n}\n';
    for (const before of [inline, multi]) {
      const added = claudeAllowRule(before, "mcp__screenpilot", false);
      expect(parse(added.replace(/\/\/.*\n/, "")).permissions.allow).toContain("mcp__screenpilot");
      expect(claudeAllowRule(added, "mcp__screenpilot", true)).toBe(before);
    }
    expect(claudeAllowRule(inline, "mcp__screenpilot", false)).toContain('"allow": ["Bash(ls)", "mcp__screenpilot"]');
  });

  it("removes a rule from the middle of an inline list and empties a one-item list to []", () => {
    const mid = '{ "permissions": { "allow": ["a", "mcp__screenpilot", "b"] } }';
    expect(claudeAllowRule(mid, "mcp__screenpilot", true)).toBe('{ "permissions": { "allow": ["a", "b"] } }');
    const only = '{ "permissions": { "allow": ["mcp__screenpilot"] } }';
    expect(claudeAllowRule(only, "mcp__screenpilot", true)).toBe('{ "permissions": { "allow": [] } }');
    expect(claudeAllowRule('{ "permissions": { "allow": [] } }', "mcp__screenpilot", false)).toBe('{ "permissions": { "allow": ["mcp__screenpilot"] } }');
  });
});
