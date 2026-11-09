import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_BIN_ENV, dashboardBin, dashboardCandidates, desktopEntry, desktopEntryFile, icnsPlan, iconCandidates, macAppFiles, syncDesktopEntry, windowsShortcutScript } from "../src/dashboard/launch.js";

let dir: string;
const saved = { bin: process.env[DASHBOARD_BIN_ENV], data: process.env.XDG_DATA_HOME };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-dash-"));
  process.env.XDG_DATA_HOME = dir;
  delete process.env[DASHBOARD_BIN_ENV];
});
afterEach(() => {
  restore(DASHBOARD_BIN_ENV, saved.bin);
  restore("XDG_DATA_HOME", saved.data);
});

describe("dashboard launcher", () => {
  it("is not installed until the program exists", async () => {
    expect(dashboardBin()).toBeUndefined();
    const bin = join(dir, "screenpilot-dashboard");
    await writeFile(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    process.env[DASHBOARD_BIN_ENV] = bin;
    expect(dashboardBin()).toBe(bin);
    process.env[DASHBOARD_BIN_ENV] = join(dir, "missing");
    expect(dashboardBin()).toBeUndefined();
  });

  it("names the icon in the desktop entry", () => {
    expect(desktopEntry("/b/screenpilot-dashboard", "/home/u/.local/share/icons/hicolor/512x512/apps/screenpilot-dashboard.png")).toContain("Icon=/home/u/.local/share/icons/hicolor/512x512/apps/screenpilot-dashboard.png");
    expect(desktopEntry("/b/x")).not.toContain("Icon=");
  });

  it("quotes the program path in the desktop entry", () => {
    const text = desktopEntry('/home/a b/"x"/screenpilot-dashboard');
    expect(text).toContain('Exec="/home/a b/\\"x\\"/screenpilot-dashboard"');
    expect(text).toContain("Terminal=false");
  });

  it.runIf(process.platform === "linux")("adds the menu entry only when installed, and removes it", async () => {
    expect(syncDesktopEntry(false)).toBeUndefined();
    const bin = join(dir, "screenpilot-dashboard");
    await mkdir(dir, { recursive: true });
    await writeFile(bin, "x");
    process.env[DASHBOARD_BIN_ENV] = bin;
    expect(syncDesktopEntry(false)?.status).toBe("added");
    expect(await readFile(desktopEntryFile(), "utf8")).toContain(`Exec="${bin}"`);
    expect(syncDesktopEntry(true)?.status).toBe("removed");
    expect(syncDesktopEntry(true)).toBeUndefined();
  });
});

describe("dashboard inside the package and the per-OS entries", () => {
  it("looks in the installed app first, then the folder it runs from, then next to the app, and accepts the .exe name on Windows", () => {
    const c = dashboardCandidates("linux", "/opt/sp", "/home/u/.local/share/screenpilot");
    // The installed app wins over the folder setup was started from (an unzipped download that may be deleted).
    expect(c).toEqual(["/home/u/.local/share/screenpilot/dashboard/screenpilot-dashboard", "/opt/sp/dashboard/screenpilot-dashboard", "/home/u/.local/share/screenpilot-dashboard/screenpilot-dashboard"]);
    expect(dashboardCandidates("win32", "C:\\sp", "C:\\app")[0]).toMatch(/screenpilot-dashboard\.exe$/);
  });

  it("builds a macOS app bundle that starts the real program", () => {
    const f = macAppFiles('/Users/a b/ScreenPilot/dashboard/screenpilot-dashboard');
    expect(f.plist).toContain("<key>CFBundleExecutable</key>");
    expect(f.plist).toContain("<string>ScreenPilot Dashboard</string>");
    expect(f.plist).toContain("<string>APPL</string>");
    expect(f.launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(f.launcher).toContain('exec "/Users/a b/ScreenPilot/dashboard/screenpilot-dashboard"');
  });

  it("escapes quotes and dollar signs in the macOS launcher", () => {
    expect(macAppFiles('/x/"y"$z/bin').launcher).toContain('exec "/x/\\"y\\"\\$z/bin"');
  });

  it("builds the Windows Start Menu shortcut script with quoted paths", () => {
    const s = windowsShortcutScript("C:\\Users\\a b\\Start Menu\\ScreenPilot Dashboard.lnk", "C:\\Program Files\\ScreenPilot\\dashboard\\screenpilot-dashboard.exe");
    expect(s).toContain("WScript.Shell");
    expect(s).toContain("CreateShortcut('C:\\Users\\a b\\Start Menu\\ScreenPilot Dashboard.lnk')");
    expect(s).toContain("TargetPath = 'C:\\Program Files\\ScreenPilot\\dashboard\\screenpilot-dashboard.exe'");
  });

  it("doubles single quotes in PowerShell strings", () => {
    expect(windowsShortcutScript("C:\\o'brien\\x.lnk", "C:\\o'brien\\d.exe")).toContain("'C:\\o''brien\\x.lnk'");
  });
});

describe("application icon", () => {
  it("finds the logo in the package (icon.png) or the repository (assets/icon.png)", () => {
    expect(iconCandidates("/opt/sp", "/home/u/.local/share/screenpilot")).toEqual(["/opt/sp/icon.png", "/opt/sp/assets/icon.png", "/home/u/.local/share/screenpilot/icon.png"]);
  });

  it("plans the macOS icon: every iconset size, then iconutil", () => {
    const plan = icnsPlan("/p/icon.png", "/t/AppIcon.iconset", "/app/Contents/Resources/AppIcon.icns");
    const names = plan.filter((c) => c[0] === "sips").map((c) => c[1].at(-1));
    expect(names).toEqual(expect.arrayContaining(["/t/AppIcon.iconset/icon_16x16.png", "/t/AppIcon.iconset/icon_16x16@2x.png", "/t/AppIcon.iconset/icon_512x512.png", "/t/AppIcon.iconset/icon_512x512@2x.png"]));
    expect(plan.at(-1)).toEqual(["iconutil", ["-c", "icns", "/t/AppIcon.iconset", "-o", "/app/Contents/Resources/AppIcon.icns"]]);
    const one = plan.find((c) => c[1].at(-1) === "/t/AppIcon.iconset/icon_32x32@2x.png");
    expect(one?.[1]).toEqual(["-z", "64", "64", "/p/icon.png", "--out", "/t/AppIcon.iconset/icon_32x32@2x.png"]);
  });

  it("points the macOS bundle at its icon and the Windows shortcut at the icon inside the program", () => {
    expect(macAppFiles("/b/x").plist).toContain("<key>CFBundleIconFile</key><string>AppIcon</string>");
    expect(windowsShortcutScript("C:\\x.lnk", "C:\\d\\screenpilot-dashboard.exe")).toContain("$s.IconLocation = 'C:\\d\\screenpilot-dashboard.exe,0'");
  });
});
