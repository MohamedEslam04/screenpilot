import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from "jsonc-parser";
import { parseDocument } from "yaml";

// Where each AI tool keeps its MCP servers, and how to add/remove ours.
// Pure functions over file text so they can be tested without touching disk.

export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClientSpec {
  id: string;
  title: string;
  /** Config file to edit. */
  file: (env: PathEnv) => string;
  /** Other names the tool also reads; an existing one is edited instead of creating `file`. */
  alternates?: (env: PathEnv) => string[];
  /** Folder whose presence means the tool is installed. */
  marker: (env: PathEnv) => string;
  format: "json" | "toml" | "yaml";
  /** Add (launch) or remove (undefined) our server in the file's text. */
  apply: (text: string, name: string, launch: ServerLaunch | undefined) => string;
}

export interface PathEnv {
  home: string;
  platform: NodeJS.Platform;
  /** Per-user app settings: %APPDATA% on Windows, ~/Library/Application Support on macOS, $XDG_CONFIG_HOME or ~/.config on Linux. */
  appData: string;
  codexHome?: string;
  copilotHome?: string;
  /** Claude Desktop from the Microsoft Store keeps its settings in its package folder: ...\\LocalCache\\Roaming\\Claude. */
  claudeStoreDir?: string;
}

const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
const j = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

/** Set or delete `path` in a JSON/JSONC document, keeping comments and formatting. */
export function jsonSet(text: string, path: (string | number)[], value: unknown): string {
  const base = text.trim() ? text : "{}\n";
  return applyEdits(base, modify(base, path, value, fmt));
}

const mcpServersJson =
  (key: string, shape: (l: ServerLaunch) => unknown) =>
  (text: string, name: string, launch: ServerLaunch | undefined): string =>
    jsonSet(text, [key, name], launch ? shape(launch) : undefined);

const standard = (l: ServerLaunch) => ({ command: l.command, args: l.args, env: l.env });

const mcpServers = mcpServersJson("mcpServers", standard);
const dirOf = (f: string) => f.slice(0, f.lastIndexOf("/"));
const json = (id: string, title: string, file: (e: PathEnv) => string, apply = mcpServers): ClientSpec => ({
  id,
  title,
  file,
  marker: (e) => dirOf(file(e)),
  format: "json",
  apply,
});
/** ~/.config: $XDG_CONFIG_HOME on Linux, the plain folder on macOS and Windows (for tools that follow XDG everywhere). */
const xdg = (e: PathEnv) => (e.platform === "linux" ? e.appData : j(e.home, ".config"));
/** Marker for a client that can't be on this machine (setup never writes there, even when asked). */
export const NEVER = "/nonexistent/screenpilot-marker";

// VS Code and its forks share one user-folder layout; Cline and Roo Code can live in any of them.
const CODE_HOSTS = [
  ["Code", "VS Code", "vscode"],
  ["Code - Insiders", "VS Code Insiders", "vscode-insiders"],
  ["VSCodium", "VSCodium", "vscodium"],
  ["Cursor", "Cursor", "cursor"],
  ["Windsurf", "Windsurf", "windsurf"],
] as const;
const codeUser = (e: PathEnv, folder: string) => j(e.appData, folder, "User");
const vscodeShape = mcpServersJson("servers", (l) => ({ type: "stdio", command: l.command, args: l.args, env: l.env }));

/** A VS Code extension's settings file; installed when its globalStorage folder exists. */
const extension = (id: string, title: string, file: (e: PathEnv) => string): ClientSpec => ({
  ...json(id, title, file),
  marker: (e) => dirOf(dirOf(file(e))),
});

export const CLIENTS: ClientSpec[] = [
  json("claude-desktop", "Claude Desktop", (e) => j(e.appData, "Claude", "claude_desktop_config.json")),
  {
    // The Store (MSIX) build reads its virtualized copy and ignores %APPDATA%\Claude.
    ...json("claude-desktop-store", "Claude Desktop (Store)", (e) => j(e.claudeStoreDir ?? NEVER, "claude_desktop_config.json")),
    marker: (e) => e.claudeStoreDir ?? NEVER,
  },
  {
    id: "codex",
    title: "Codex",
    file: (e) => j(e.codexHome ?? j(e.home, ".codex"), "config.toml"),
    marker: (e) => e.codexHome ?? j(e.home, ".codex"),
    format: "toml",
    apply: (text, name, launch) => tomlServer(text, name, launch),
  },
  {
    id: "opencode",
    title: "OpenCode",
    file: (e) => j(openCodeDir(e), "opencode.json"),
    alternates: (e) => [j(openCodeDir(e), "opencode.jsonc")],
    marker: (e) => openCodeDir(e),
    format: "json",
    apply: openCode,
  },
  json("cursor", "Cursor", (e) => j(e.home, ".cursor", "mcp.json")),
  json("gemini", "Gemini CLI", (e) => j(e.home, ".gemini", "settings.json")),
  json("antigravity", "Antigravity", (e) => j(e.home, ".gemini", "antigravity", "mcp_config.json")),
  json("windsurf", "Windsurf", (e) => j(e.home, ".codeium", "windsurf", "mcp_config.json")),
  json("devin", "Devin Desktop", (e) => j(e.platform === "win32" ? j(e.appData, "devin") : j(xdg(e), "devin"), "mcp_config.json")),
  ...CODE_HOSTS.slice(0, 3).map(([folder, title, id]) => ({
    ...json(id, title, (e) => j(codeUser(e, folder), "mcp.json"), vscodeShape),
    marker: (e: PathEnv) => codeUser(e, folder),
  })),
  ...CODE_HOSTS.flatMap(([folder, host, id]) => [
    extension(`cline-${id}`, `Cline (${host})`, (e) =>
      j(codeUser(e, folder), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    ),
    extension(`roo-${id}`, `Roo Code (${host})`, (e) =>
      j(codeUser(e, folder), "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
    ),
  ]),
  json("zed", "Zed", (e) => j(e.platform === "win32" ? j(e.appData, "Zed") : j(xdg(e), "zed"), "settings.json"), mcpServersJson("context_servers", standard)),
  json("lmstudio", "LM Studio", (e) => j(e.home, ".lmstudio", "mcp.json")),
  { ...json("kiro", "Kiro", (e) => j(e.home, ".kiro", "settings", "mcp.json")), marker: (e) => j(e.home, ".kiro") },
  json("qwen", "Qwen Code", (e) => j(e.home, ".qwen", "settings.json")),
  json(
    "copilot",
    "GitHub Copilot CLI",
    (e) => j(e.copilotHome ?? j(e.home, ".copilot"), "mcp-config.json"),
    mcpServersJson("mcpServers", (l) => ({ type: "local", command: l.command, args: l.args, env: l.env, tools: ["*"] })),
  ),
  json("amazonq", "Amazon Q", (e) => j(e.home, ".aws", "amazonq", "mcp.json")),
  json("warp", "Warp", (e) => j(e.home, ".warp", ".mcp.json")),
  {
    id: "goose",
    title: "Goose",
    file: (e) => (e.platform === "win32" ? j(e.appData, "Block", "goose", "config", "config.yaml") : j(xdg(e), "goose", "config.yaml")),
    marker: (e) => (e.platform === "win32" ? j(e.appData, "Block", "goose") : j(xdg(e), "goose")),
    format: "yaml",
    apply: gooseServer,
  },
];

/** Goose: `extensions.<name>` in YAML, with `cmd`/`envs` instead of `command`/`env`. */
export function gooseServer(text: string, name: string, launch: ServerLaunch | undefined): string {
  const doc = parseDocument(text.trim() ? text : "{}");
  if (launch) {
    doc.setIn(["extensions", name], {
      type: "stdio",
      name,
      enabled: true,
      cmd: launch.command,
      args: launch.args,
      envs: launch.env,
      env_keys: [],
      timeout: 300,
    });
  } else {
    doc.deleteIn(["extensions", name]);
  }
  return doc.toString();
}

/**
 * OpenCode 2.x keeps servers under `mcp.servers` (with `disabled`); 1.x put them
 * straight under `mcp` (with `enabled`). 2.x still reads the 1.x shape, so that is
 * the default; a file already on the 2.x layout gets the 2.x shape.
 */
function openCode(text: string, name: string, launch: ServerLaunch | undefined): string {
  const doc = (text.trim() ? parse(text, [], { allowTrailingComma: true }) : {}) as { mcp?: { servers?: unknown } } | undefined;
  const v2 = typeof doc?.mcp?.servers === "object";
  let out = text;
  // Drop a stale entry from the other layout so there is only one.
  for (const path of [["mcp", name], ["mcp", "servers", name]]) {
    const tree = parseTree(out);
    if (tree && findNodeAtLocation(tree, path)) out = jsonSet(out, path, undefined);
  }
  if (!launch) return out;
  const command = [launch.command, ...launch.args];
  return v2
    ? jsonSet(out, ["mcp", "servers", name], { type: "local", command, disabled: false, environment: launch.env })
    : jsonSet(out, ["mcp", name], { type: "local", command, enabled: true, environment: launch.env });
}

/** OpenCode follows XDG on every OS: ~/.config/opencode even on Windows and macOS. */
const openCodeDir = (e: PathEnv) => j(xdg(e), "opencode");

/** True when our server is already configured with this exact launch. */
export function hasServer(spec: ClientSpec, text: string, name: string, launch: ServerLaunch): boolean {
  return spec.apply(text, name, launch) === text;
}

// --- Codex config.toml: edited as text so the user's comments survive ---

const q = (s: string) => JSON.stringify(s); // TOML basic strings use JSON-compatible escapes

/** Replace (or remove) the [mcp_servers.<name>] table and its sub-tables. */
export function tomlServer(text: string, name: string, launch: ServerLaunch | undefined): string {
  const header = `[mcp_servers.${name}]`;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("[")) {
      skipping = t === header || t.startsWith(`[mcp_servers.${name}.`);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  while (out.length && out.at(-1)!.trim() === "") out.pop();
  if (launch) {
    const env = Object.entries(launch.env)
      .map(([k, v]) => `${q(k)} = ${q(v)}`)
      .join(", ");
    if (out.length) out.push("");
    out.push(header, `command = ${q(launch.command)}`, `args = [${launch.args.map(q).join(", ")}]`, `env = { ${env} }`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Add (or remove) a permission rule in Claude Code's settings.json `permissions.allow`,
 * keeping every other entry and comment. `rule` "mcp__<server>" allows all of that server's tools.
 */
export function claudeAllowRule(text: string, rule: string, remove: boolean): string {
  const doc = (parse(text, [], { allowTrailingComma: true }) ?? {}) as { permissions?: { allow?: unknown } };
  const existing = doc.permissions?.allow;
  const current = Array.isArray(existing) ? (existing as unknown[]) : [];
  const at = current.indexOf(rule);
  if (remove ? at < 0 : at >= 0) return text;
  if (!Array.isArray(existing)) return jsonSet(text, ["permissions", "allow"], [rule]);
  const arr = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true })!, ["permissions", "allow"])!;
  const kids = arr.children ?? [];
  const edit = (offset: number, length: number, content: string) => applyEdits(text, [{ offset, length, content }]);
  if (remove && kids.length === 1) return edit(arr.offset, arr.length, "[]");
  // `["a", "b"]` on one line: splice by hand so the line is not expanded. Multi-line arrays use the formatter.
  if (!text.slice(arr.offset, arr.offset + arr.length).includes("\n")) {
    if (!remove) {
      const last = kids.at(-1);
      return last ? edit(last.offset + last.length, 0, `, ${JSON.stringify(rule)}`) : edit(arr.offset + 1, 0, JSON.stringify(rule));
    }
    const kid = kids[at]!;
    const next = kids[at + 1];
    return next ? edit(kid.offset, next.offset - kid.offset, "") : edit(kids[at - 1]!.offset + kids[at - 1]!.length, kid.offset + kid.length - (kids[at - 1]!.offset + kids[at - 1]!.length), "");
  }
  return remove ? applyEdits(text, modify(text, ["permissions", "allow", at], undefined, fmt)) : applyEdits(text, modify(text, ["permissions", "allow", -1], rule, { ...fmt, isArrayInsertion: true }));
}

/** Parse check used before writing: never save a file we broke. */
export function stillValid(spec: ClientSpec, text: string): boolean {
  if (spec.format === "toml") return true;
  if (spec.format === "yaml") return parseDocument(text).errors.length === 0;
  const errors: { error: number }[] = [];
  parse(text, errors as never, { allowTrailingComma: true });
  return errors.length === 0;
}
