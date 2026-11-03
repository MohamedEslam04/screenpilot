import { existsSync } from "node:fs";
import { probeDuration } from "../util/media.js";
import type { VoiceClip, VoiceLine } from "./index.js";

/**
 * A narration line whose audio the user made elsewhere (a web TTS, a recording).
 * The duration is probed each time and no sidecar is written, because the user
 * may replace the file under the same name.
 */
export async function externalClip(line: VoiceLine, file: string, index: number): Promise<VoiceClip> {
  if (!existsSync(file)) throw new Error(`narration[${index}].audio not found: ${file}`);
  return { ...line, file, duration: await probeDuration(file) };
}
