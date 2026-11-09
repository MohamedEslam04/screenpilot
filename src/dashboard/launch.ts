import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP, APP_TITLE } from "../brand.js";
import { appHome, packageRoot } from "../setup/index.js";

// The dashboard is a small native program that ships inside the package (`dashboard/` next to `dist/`).
// A build from the repository can instead sit next to the app folder (dashboardHome()).

export const DASHBOARD_BIN_ENV = `${APP.toUpperCase()}_DASHBOARD_BIN`;
const exeFor = (os: NodeJS.Platform) => (os === "win32" ? `${APP}-dashboard.exe` : `${APP}-dashboard`);

/** Where a build from the repository can be installed: a sibling of the app folder. */
export function dashboardHome(): string {
  return `${appHome()}-dashboard`;
}

/** Where the program may be, best first: the installed app, the folder this runs from, next to the app. */
export function dashboardCandidates(os: NodeJS.Platform = process.platform, root = packageRoot(), app = appHome()): string[] {
  const exe = exeFor(os);
  return [join(app, "dashboard", exe), join(root, "dashboard", exe), join(`${app}-dashboard`, exe)];
}

/** The dashboard program to start: $SCREENPILOT_DASHBOARD_BIN, else the first candidate that exists. undefined when not installed. */
export function dashboardBin(): string | undefined {
  const fromEnv = process.env[DASHBOARD_BIN_ENV];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  return dashboardCandidates().find((p) => existsSync(p));
}

/** Start the dashboard detached and return at once: it is its own program with its own window. */
export function launchDashboard(bin: string): void {
  spawn(bin, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
}

const shQuote = (s: string) => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

/** The freedesktop entry for the dashboard (Exec is quoted so a path with spaces stays one argument). */
export function desktopEntry(bin: string, icon?: string): string {
  return ["[Desktop Entry]", "Type=Application", `Name=${APP_TITLE}`, "Comment=Your ScreenPilot recordings, renders and voices", `Exec=${shQuote(bin)}`, ...(icon ? [`Icon=${icon}`] : []), "Terminal=false", "Categories=AudioVideo;Video;", ""].join("\n");
}

/** Where the logo may be: icon.png in the package, assets/icon.png in the repository, icon.png in the installed app. */
export function iconCandidates(root = packageRoot(), app = appHome()): string[] {
  return [join(root, "icon.png"), join(root, "assets", "icon.png"), join(app, "icon.png")];
}

const iconSource = () => iconCandidates().find((p) => existsSync(p));

export function linuxIconFile(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "icons", "hicolor", "512x512", "apps", `${APP}-dashboard.png`);
}

/** The iconutil recipe for a macOS .icns: every size Apple wants, then the packing step. Commands are [program, args]. */
export function icnsPlan(png: string, iconset: string, icns: string): [string, string[]][] {
  const plan: [string, string[]][] = [];
  for (const size of [16, 32, 128, 256, 512]) {
    plan.push(["sips", ["-z", String(size), String(size), png, "--out", join(iconset, `icon_${size}x${size}.png`)]]);
    plan.push(["sips", ["-z", String(size * 2), String(size * 2), png, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]]);
  }
  plan.push(["iconutil", ["-c", "icns", iconset, "-o", icns]]);
  return plan;
}

/** Make AppIcon.icns from the logo with the tools every Mac has. Best effort: an app without an icon still works. */
function writeIcns(png: string, icns: string): boolean {
  const work = mkdtempSync(join(tmpdir(), "sp-icns-"));
  try {
    const iconset = join(work, "AppIcon.iconset");
    mkdirSync(iconset, { recursive: true });
    mkdirSync(dirname(icns), { recursive: true });
    for (const [cmd, args] of icnsPlan(png, iconset, icns)) {
      if (spawnSync(cmd, args, { stdio: "ignore" }).status !== 0) return false;
    }
    return existsSync(icns);
  } catch {
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function desktopEntryFile(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "applications", `${APP}-dashboard.desktop`);
}

const MAC_NAME = `${APP_TITLE} Dashboard`;

/** A tiny macOS app bundle: Finder and Launchpad show it, and it starts the real program. */
export function macAppFiles(bin: string): { plist: string; launcher: string } {
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>CFBundleName</key><string>${MAC_NAME}</string>`,
    `<key>CFBundleDisplayName</key><string>${MAC_NAME}</string>`,
    `<key>CFBundleExecutable</key><string>${MAC_NAME}</string>`,
    `<key>CFBundleIdentifier</key><string>dev.${APP}.dashboard</string>`,
    "<key>CFBundlePackageType</key><string>APPL</string>",
    "<key>CFBundleIconFile</key><string>AppIcon</string>",
    "<key>CFBundleVersion</key><string>1</string>",
    "<key>NSHighResolutionCapable</key><true/>",
    "</dict></plist>",
    "",
  ].join("\n");
  return { plist, launcher: `#!/bin/sh\nexec ${shQuote(bin)}\n` };
}

export function macAppDir(): string {
  return join(homedir(), "Applications", `${MAC_NAME}.app`);
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** PowerShell that writes a shortcut (.lnk) to the program. */
export function windowsShortcutScript(lnk: string, bin: string): string {
  return `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)}); $s.TargetPath = ${psQuote(bin)}; $s.IconLocation = ${psQuote(`${bin},0`)}; $s.WorkingDirectory = ${psQuote(dirname(bin))}; $s.Description = 'Your ScreenPilot recordings, renders and voices'; $s.Save()`;
}

export function windowsShortcutFile(): string {
  const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(base, "Microsoft", "Windows", "Start Menu", "Programs", `${MAC_NAME}.lnk`);
}

export interface EntryStatus {
  status: "added" | "removed" | "not installed";
  detail: string;
}

/** Put the dashboard in the application menu (Linux), ~/Applications (macOS) or the Start Menu (Windows), or take it out again. undefined: nothing to do. */
export function syncDesktopEntry(remove: boolean): EntryStatus | undefined {
  if (process.platform === "linux") {
    const icon = linuxIconFile();
    if (remove) rmSync(icon, { force: true });
    return syncFile(desktopEntryFile(), remove, (file, bin) => {
      const src = iconSource();
      if (src) {
        mkdirSync(dirname(icon), { recursive: true });
        copyFileSync(src, icon);
      }
      writeFileSync(file, desktopEntry(bin, src ? icon : undefined));
    });
  }
  if (process.platform === "darwin") {
    const app = macAppDir();
    if (remove) {
      if (!existsSync(app)) return undefined;
      rmSync(app, { recursive: true, force: true });
      return { status: "removed", detail: app };
    }
    const bin = dashboardBin();
    if (!bin) return undefined;
    const files = macAppFiles(bin);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), files.plist);
    const launcher = join(app, "Contents", "MacOS", MAC_NAME);
    writeFileSync(launcher, files.launcher);
    chmodSync(launcher, 0o755);
    const logo = iconSource();
    if (logo) writeIcns(logo, join(app, "Contents", "Resources", "AppIcon.icns"));
    return { status: "added", detail: app };
  }
  if (process.platform === "win32") {
    return syncFile(windowsShortcutFile(), remove, (file, bin) => {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsShortcutScript(file, bin)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`could not create the Start Menu shortcut: ${(r.stderr || r.error?.message || "").trim()}`);
    });
  }
  return undefined;
}

function syncFile(file: string, remove: boolean, write: (file: string, bin: string) => void): EntryStatus | undefined {
  if (remove) {
    if (!existsSync(file)) return undefined;
    rmSync(file, { force: true });
    return { status: "removed", detail: file };
  }
  const bin = dashboardBin();
  if (!bin) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  write(file, bin);
  return { status: "added", detail: file };
}
