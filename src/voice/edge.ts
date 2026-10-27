import { createWriteStream } from "node:fs";
import { rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { VoiceInfo, VoiceProvider } from "./index.js";

// Microsoft Edge "read aloud" voices: free, no key, needs network.
export const edgeProvider: VoiceProvider = {
  id: "edge",

  async synthesize(text, voice, rate, outFile) {
    // The service drops a stream now and then; the same line works on retry.
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTimeout(synthesizeOnce(text, voice, rate, outFile), 20_000, "Edge TTS did not answer in 20 s");
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  },

  async listVoices(): Promise<VoiceInfo[]> {
    const tts = new MsEdgeTTS();
    try {
      const voices = await tts.getVoices();
      return voices.map((v) => ({ name: v.ShortName, locale: v.Locale, gender: v.Gender }));
    } finally {
      tts.close();
    }
  },
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function synthesizeOnce(text: string, voice: string, rate: string, outFile: string): Promise<void> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text), { rate });
    const tmp = `${outFile}.part`;
    await pipeline(audioStream, createWriteStream(tmp));
    await rename(tmp, outFile);
  } finally {
    tts.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
