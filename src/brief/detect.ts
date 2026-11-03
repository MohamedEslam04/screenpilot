import { getDesktop } from "../platform/index.js";
import { loadVoiceConfig } from "../voice/config.js";
import { LOCAL_PYTHON_ENV } from "../voice/local.js";
import type { BriefEnv } from "./questions.js";

/** What this machine has, for the questions. Offline and cheap: nothing is started. */
export async function detectBriefEnv(): Promise<BriefEnv> {
  let localVoice = false;
  let commandVoices: string[] = [];
  try {
    const cfg = loadVoiceConfig();
    localVoice = !!(process.env[LOCAL_PYTHON_ENV] || cfg.local.python);
    commandVoices = Object.keys(cfg.commands);
  } catch {
    // an unreadable voices.json shows up in `doctor`; the questions still work
  }
  let desktop: BriefEnv["desktop"];
  try {
    const d = await getDesktop();
    desktop = { id: d.id, windowControl: d.windowControl };
  } catch {
    // no drivable desktop here
  }
  return { localVoice, commandVoices, desktop };
}
