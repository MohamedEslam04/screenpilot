import { describe, expect, it } from "vitest";
import { expandWinVars, parseRegVideos, parseUserDirs } from "../src/setup/folders.js";

describe("videos folder", () => {
  it("reads a OneDrive-redirected Videos folder from the registry", () => {
    const out = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    My Video    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Videos
`;
    const raw = parseRegVideos(out)!;
    expect(raw).toBe("%USERPROFILE%\\OneDrive\\Videos");
    expect(expandWinVars(raw, { UserProfile: "C:\\Users\\محمد" })).toBe("C:\\Users\\محمد\\OneDrive\\Videos");
  });

  it("reads a localized XDG videos dir", () => {
    const text = 'XDG_DESKTOP_DIR="$HOME/سطح المكتب"\nXDG_VIDEOS_DIR="$HOME/الفيديوهات"\n';
    expect(parseUserDirs(text, "/home/u")).toBe("/home/u/الفيديوهات");
  });

  it("ignores an unset XDG entry (points at $HOME)", () => {
    expect(parseUserDirs('XDG_VIDEOS_DIR="$HOME/"\n', "/home/u")).toBeUndefined();
    expect(parseUserDirs("", "/home/u")).toBeUndefined();
  });

  it("leaves unknown %VARS% alone", () => {
    expect(expandWinVars("%NOPE%\\x", {})).toBe("%NOPE%\\x");
  });
});
