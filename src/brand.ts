import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The product name lives here and only here. Renaming the project = change
// APP (and add the old name to PREVIOUS_NAMES so existing users keep their
// settings: the config folder is moved over on first use).

export const APP = "screenpilot";
/** Display name. */
export const APP_TITLE = "ScreenPilot";
export const PREVIOUS_NAMES: string[] = ["demoreel"];

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

/** Env var naming where sessions go (the desktop extension sets it from its settings). */
export const OUTPUT_ENV = `${APP.toUpperCase()}_OUTPUT`;

/** Env var forcing the desktop backend (kde, x11, portal or windows) instead of detecting it. */
export const DESKTOP_ENV = `${APP.toUpperCase()}_DESKTOP`;

/** "off": driving ignores the pointer being moved by anyone else (unattended agents). */
export const INTERRUPT_ENV = `${APP.toUpperCase()}_INTERRUPT`;
/** Comma list of env var names the agent may type from ({env: NAME}). Unset: any. */
export const ALLOW_ENV_ENV = `${APP.toUpperCase()}_ALLOW_ENV`;
/** Comma list of app names (window class or title substrings) the agent may click or type into. Unset: any. */
export const ALLOW_APPS_ENV = `${APP.toUpperCase()}_ALLOW_APPS`;
/** Seconds after which a perform is aborted. Unset: no limit. */
export const PERFORM_TIMEOUT_ENV = `${APP.toUpperCase()}_PERFORM_TIMEOUT`;

/** Folder for new recording sessions: $SCREENPILOT_OUTPUT, else ./sessions. */
export function sessionsRoot(): string {
  return process.env[OUTPUT_ENV] || "sessions";
}

/** The app version, from package.json (one level above src/ and dist/). */
export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
