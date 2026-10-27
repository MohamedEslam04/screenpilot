import { describe, expect, it } from "vitest";
import { appOfPath, hostAppOf, parsePs, permissionHelp } from "../src/platform/macos/permissions.js";

// `ps -A -o pid=,ppid=,comm=` on macOS: comm is the executable path (with spaces).
const PS = `
    1     0 /sbin/launchd
  501     1 /Applications/Claude.app/Contents/MacOS/Claude
  640   501 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
  700   640 /Users/me/Library/Application Support/ScreenPilot/bin/node
  800     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  801   800 /usr/bin/login
  802   801 -zsh
  803   802 /opt/homebrew/bin/node
  900   999 /usr/local/bin/node
`;

describe("macOS host app", () => {
  it("parses ps output, keeping paths with spaces", () => {
    const procs = parsePs(PS);
    expect(procs.get(640)).toEqual({ pid: 640, ppid: 501, path: "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper" });
    expect(procs.size).toBe(9);
  });

  it("names the outermost app bundle", () => {
    expect(appOfPath("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)")).toBe("Cursor");
    expect(appOfPath("/opt/homebrew/bin/node")).toBeUndefined();
  });

  it("walks up to the app that macOS asks permission for", () => {
    const procs = parsePs(PS);
    expect(hostAppOf(procs, 700)).toBe("Claude");
    expect(hostAppOf(procs, 803)).toBe("Terminal");
    expect(hostAppOf(procs, 900)).toBeUndefined(); // parent gone
  });

  it("gives exact fix steps naming the app and the settings pane", () => {
    const msg = permissionHelp("accessibility", "Claude");
    expect(msg).toContain("System Settings > Privacy & Security > Accessibility");
    expect(msg).toContain('turn on "Claude"');
    expect(msg).toContain('quit and reopen "Claude"');
    expect(permissionHelp("screen", "Terminal")).toContain("Screen & System Audio Recording");
    expect(permissionHelp("input", "Cursor")).toContain("Input Monitoring");
  });
});
