import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { probeDuration } from "../util/media.js";
import { edgeProvider } from "./edge.js";

export interface VoiceInfo {
  name: string;
  locale: string;
  gender: string;
}

export interface VoiceProvider {
  id: string;
  synthesize(text: string, voice: string, rate: string, outFile: string): Promise<void>;
  listVoices(): Promise<VoiceInfo[]>;
}

const providers: Record<string, VoiceProvider> = { edge: edgeProvider };

export function getProvider(id: string): VoiceProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown voice provider "${id}". Available: ${Object.keys(providers).join(", ")}`);
  return p;
}

export interface VoiceLine {
  text: string;
  voice: string;
  rate: string;
}

export interface VoiceClip extends VoiceLine {
  file: string;
  duration: number;
}

/** Synthesize lines into `dir`, reusing files whose text/voice/rate did not change. */
export async function synthesizeLines(providerId: string, lines: VoiceLine[], dir: string): Promise<VoiceClip[]> {
  const provider = getProvider(providerId);
  await mkdir(dir, { recursive: true });
  const clips: VoiceClip[] = [];
  for (const line of lines) {
    const hash = createHash("sha1").update(`${provider.id}|${line.voice}|${line.rate}|${line.text}`).digest("hex");
    const file = join(dir, `${hash.slice(0, 16)}.mp3`);
    if (!existsSync(file)) await provider.synthesize(line.text, line.voice, line.rate, file);
    clips.push({ ...line, file, duration: await probeDuration(file) });
  }
  return clips;
}
