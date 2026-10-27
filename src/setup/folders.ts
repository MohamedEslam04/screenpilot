import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_TITLE } from "../brand.js";

// The user's real Videos folder: OneDrive can move it on Windows, and Linux
// desktops localize it (e.g. ~/الفيديوهات), so ~/Videos is only a fallback.

/** Expand %VAR% (Windows) references. */
export function expandWinVars(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/%([^%]+)%/g, (m, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? m) : m;
  });
}

/** `My Video` from `reg query` output of Explorer's User Shell Folders. */
export function parseRegVideos(out: string): string | undefined {
  const m = out.match(/^\s*My Video\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
  return m?.[1];
}

/** XDG_VIDEOS_DIR from ~/.config/user-dirs.dirs. */
export function parseUserDirs(text: string, home: string): string | undefined {
  const m = text.match(/^XDG_VIDEOS_DIR="(.*)"\s*$/m);
  if (!m?.[1]) return undefined;
  const dir = m[1].replace(/^\$HOME/, home);
  // Unset entries point at $HOME itself.
  return dir.replace(/\/+$/, "") === home.replace(/\/+$/, "") ? undefined : dir;
}

export function videosDir(): string {
  const home = homedir();
  try {
    if (process.platform === "win32") {
      const r = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "My Video"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const raw = r.status === 0 ? parseRegVideos(r.stdout) : undefined;
      if (raw) return expandWinVars(raw);
    } else if (process.platform === "darwin") {
      return join(home, "Movies");
    } else {
      const file = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "user-dirs.dirs");
      const dir = existsSync(file) ? parseUserDirs(readFileSync(file, "utf8"), home) : undefined;
      if (dir) return dir;
    }
  } catch {
    // fall through
  }
  return join(home, "Videos");
}

/** Default folder for recordings and finished videos. */
export const defaultOutputDir = () => join(videosDir(), APP_TITLE);
