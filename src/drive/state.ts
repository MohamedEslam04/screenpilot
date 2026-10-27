import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../brand.js";

// Small per-user state: portal restore token, confirmed OBS source → monitor map.

export interface State {
  remoteDesktopToken?: string;
  sourceMap?: Record<string, string>;
  /** OBS record folder to put back if a recording was interrupted. */
  pendingRecordDir?: string;
  /** OBS video settings to put back if a multi-monitor recording was interrupted. */
  pendingVideoRestore?: {
    baseWidth: number;
    baseHeight: number;
    outputWidth: number;
    outputHeight: number;
    fpsNumerator: number;
    fpsDenominator: number;
  };
}

export function statePath(): string {
  return join(configDir(), "state.json");
}

export async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as State;
  } catch {
    return {};
  }
}

export async function saveState(state: State): Promise<void> {
  const p = statePath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(state, null, 2)}\n`);
  await chmod(p, 0o600); // the token grants input control without asking
}
