import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The product name lives here and only here. Renaming the project = change
// APP (and add the old name to PREVIOUS_NAMES so existing users keep their
// settings: the config folder is moved over on first use).

export const APP = "demoreel";
export const PREVIOUS_NAMES: string[] = [];

/** D-Bus well-known-name / object-path prefixes. */
export const DBUS_NAME = `dev.${APP}`;
export const DBUS_PATH = `/dev/${APP}`;

/** Folder (next to a storyboard or take) for cached voice clips etc. */
export const CACHE_DIR = `.${APP}-cache`;

/** A name for something we create (temp files, OBS scenes, KWin scripts). */
export const named = (suffix: string) => `${APP}-${suffix}`;

/** Things named by us (now or under a previous name), e.g. OBS sources we must not treat as the user's. */
export const isOurs = (name: string) => [APP, ...PREVIOUS_NAMES].some((n) => name.startsWith(n));

function configBase(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  return join(homedir(), ".config");
}

/** Per-user config folder (state, demo-browser profile), migrated from a previous name if needed. */
export function configDir(app = APP, previous = PREVIOUS_NAMES): string {
  const dir = join(configBase(), app);
  if (!existsSync(dir)) {
    const old = previous.map((n) => join(configBase(), n)).find((p) => existsSync(p));
    if (old) renameSync(old, dir);
  }
  return dir;
}
