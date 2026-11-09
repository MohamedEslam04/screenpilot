import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP, APP_TITLE } from "../brand.js";
import { appHome } from "../setup/index.js";

// The dashboard is a separate desktop program (Tauri), downloaded on its own. It lives next to the
// app folder, not inside it, because `setup` replaces the app folder every time it runs.

export const DASHBOARD_BIN_ENV = `${APP.toUpperCase()}_DASHBOARD_BIN`;
const exe = process.platform === "win32" ? `${APP}-dashboard.exe` : `${APP}-dashboard`;

/** Where the dashboard program is installed: a sibling of the app folder. */
export function dashboardHome(): string {
  return `${appHome()}-dashboard`;
}

/** The dashboard program to start: $SCREENPILOT_DASHBOARD_BIN, else the one in dashboardHome(). undefined when not installed. */
export function dashboardBin(): string | undefined {
  const fromEnv = process.env[DASHBOARD_BIN_ENV];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const installed = join(dashboardHome(), exe);
  return existsSync(installed) ? installed : undefined;
}

/** Start the dashboard detached and return at once: it is its own program with its own window. */
export function launchDashboard(bin: string): void {
  spawn(bin, [], { detached: true, stdio: "ignore" }).unref();
}

/** The freedesktop entry for the dashboard (Exec is quoted so a path with spaces stays one argument). */
export function desktopEntry(bin: string): string {
  const quoted = `"${bin.replace(/(["`$\\])/g, "\\$1")}"`;
  return ["[Desktop Entry]", "Type=Application", `Name=${APP_TITLE}`, "Comment=Your ScreenPilot recordings, renders and voices", `Exec=${quoted}`, "Terminal=false", "Categories=AudioVideo;Video;", ""].join("\n");
}

export function desktopEntryFile(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "applications", `${APP}-dashboard.desktop`);
}

/** Linux only: add (or remove) the application-menu entry. Returns a short status, or undefined when there is nothing to do here. */
export function syncDesktopEntry(remove: boolean): { status: "added" | "removed" | "not installed"; detail: string } | undefined {
  if (process.platform !== "linux") return undefined;
  const file = desktopEntryFile();
  if (remove) {
    if (!existsSync(file)) return undefined;
    rmSync(file, { force: true });
    return { status: "removed", detail: file };
  }
  const bin = dashboardBin();
  if (!bin) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, desktopEntry(bin));
  return { status: "added", detail: file };
}
