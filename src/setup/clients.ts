import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from "jsonc-parser";

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
  format: "json" | "toml";
  /** Add (launch) or remove (undefined) our server in the file's text. */
  apply: (text: string, name: string, launch: ServerLaunch | undefined) => string;
}

export interface PathEnv {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows, ~/.config elsewhere. */
  appData: string;
  codexHome?: string;
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

export const CLIENTS: ClientSpec[] = [
  {
    id: "claude-desktop",
    title: "Claude Desktop",
    file: (e) => j(e.appData, "Claude", "claude_desktop_config.json"),
    marker: (e) => j(e.appData, "Claude"),
    format: "json",
    apply: mcpServersJson("mcpServers", standard),
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
  {
    id: "cursor",
    title: "Cursor",
    file: (e) => j(e.home, ".cursor", "mcp.json"),
    marker: (e) => j(e.home, ".cursor"),
    format: "json",
    apply: mcpServersJson("mcpServers", standard),
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    file: (e) => j(e.home, ".gemini", "settings.json"),
    marker: (e) => j(e.home, ".gemini"),
    format: "json",
    apply: mcpServersJson("mcpServers", standard),
  },
  {
    id: "windsurf",
    title: "Windsurf",
    file: (e) => j(e.home, ".codeium", "windsurf", "mcp_config.json"),
    marker: (e) => j(e.home, ".codeium", "windsurf"),
    format: "json",
    apply: mcpServersJson("mcpServers", standard),
  },
  {
    id: "vscode",
    title: "VS Code",
    file: (e) => j(e.appData, "Code", "User", "mcp.json"),
    marker: (e) => j(e.appData, "Code", "User"),
    format: "json",
    apply: mcpServersJson("servers", (l) => ({ type: "stdio", command: l.command, args: l.args, env: l.env })),
  },
];

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

/** OpenCode follows XDG on every OS: ~/.config/opencode even on Windows. */
const openCodeDir = (e: PathEnv) => j(e.platform === "win32" ? j(e.home, ".config") : e.appData, "opencode");

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

/** Parse check used before writing: never save a file we broke. */
export function stillValid(spec: ClientSpec, text: string): boolean {
  if (spec.format === "toml") return true;
  const errors: { error: number }[] = [];
  parse(text, errors as never, { allowTrailingComma: true });
  return errors.length === 0;
}
