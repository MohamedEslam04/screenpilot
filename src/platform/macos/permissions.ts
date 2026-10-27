import { spawn } from "node:child_process";
import { run } from "../../util/exec.js";
import { APP_TITLE } from "../../brand.js";

// macOS privacy permissions (TCC). They are granted to the APP that started
// us (Claude, Cursor, Terminal...), not to node, so messages name that app.

export type Permission = "accessibility" | "screen" | "input";

const PANES: Record<Permission, { pane: string; title: string; why: string }> = {
  accessibility: { pane: "Privacy_Accessibility", title: "Accessibility", why: "to move the mouse, click, type and arrange windows" },
  screen: { pane: "Privacy_ScreenCapture", title: "Screen & System Audio Recording (Screen Recording on macOS 14 and older)", why: "to record and screenshot the screen" },
  input: { pane: "Privacy_ListenEvent", title: "Input Monitoring", why: "to log your clicks while recording (for zooms and click ripples)" },
};

/** One process from `ps -A -o pid=,ppid=,comm=` (comm is the executable path on macOS). */
export interface Proc {
  pid: number;
  ppid: number;
  path: string;
}

export function parsePs(stdout: string): Map<number, Proc> {
  const out = new Map<number, Proc>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), path: m[3]! });
  }
  return out;
}

/** Name of the outermost .app bundle in an executable path ("Cursor" for ".../Cursor.app/.../Cursor Helper.app/..."). */
export function appOfPath(path: string): string | undefined {
  return /\/([^/]+)\.app\//.exec(path)?.[1];
}

/** The nearest ancestor of `pid` that is an app bundle: that is who macOS asks permission for. */
export function hostAppOf(procs: Map<number, Proc>, pid: number): string | undefined {
  const seen = new Set<number>();
  for (let p = procs.get(pid); p && !seen.has(p.pid); p = procs.get(p.ppid)) {
    seen.add(p.pid);
    const app = appOfPath(p.path);
    if (app) return app;
  }
  return undefined;
}

let host: Promise<string> | undefined;

/** The app that launched us, e.g. "Claude"; a generic description when it can't be told. */
export function hostApp(): Promise<string> {
  return (host ??= run("ps", ["-A", "-o", "pid=,ppid=,comm="])
    .then((r) => hostAppOf(parsePs(r.stdout), process.pid))
    .catch(() => undefined)
    .then((a) => a ?? "the app that runs " + APP_TITLE + " (Claude, Cursor, your terminal...)"));
}

/** Exact fix steps for a missing permission. */
export function permissionHelp(p: Permission, app: string): string {
  const { title, why } = PANES[p];
  const quoted = app.startsWith("the app") ? app : `"${app}"`;
  return (
    `${APP_TITLE} needs macOS ${title} permission ${why}. ` +
    `Open System Settings > Privacy & Security > ${title}, turn on ${quoted} (click + to add it if it is not listed), ` +
    `then quit and reopen ${quoted}. macOS grants this to the app that starts ${APP_TITLE}, not to ${APP_TITLE} itself.`
  );
}

const opened = new Set<Permission>();

/** Open the right System Settings pane, once per process (no output: the MCP server owns stdout). */
export function openPermissionPane(p: Permission): void {
  if (opened.has(p) || process.platform !== "darwin") return;
  opened.add(p);
  try {
    spawn("open", [`x-apple.systempreferences:com.apple.preference.security?${PANES[p].pane}`], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // the message alone still says where to go
  }
}

/** An Error with the fix steps; also opens the settings pane so the user lands in the right place. */
export async function permissionError(p: Permission): Promise<Error> {
  openPermissionPane(p);
  return new Error(permissionHelp(p, await hostApp()));
}
