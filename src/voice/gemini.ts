import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchWithRetry } from "./http.js";
import type { VoiceInfo, VoiceProvider } from "./index.js";
import { getSecret } from "./secrets.js";

// Gemini API text to speech (https://ai.google.dev/gemini-api/docs/speech-generation).
// Needs GEMINI_API_KEY. The voice name is one of the prebuilt voices below.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const SAMPLE_RATE = 24000; // the TTS models answer 24 kHz, 16-bit, mono PCM

// The 30 prebuilt voices of the docs. They speak every supported language; the language is detected from the text.
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

const model = () => process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;

/** Wrap raw 16-bit mono PCM in a 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface GeminiReply {
  candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
}

export const geminiProvider: VoiceProvider = {
  id: "gemini",
  ext: () => "wav",
  // The voice name is already part of the key; the model changes the audio without changing it.
  cacheKey: () => model(),

  // The API has no speed setting, so `rate` is ignored (a style hint in the text could do it, but would be read aloud).
  async synthesize(text, voice, _rate, outFile) {
    const key = getSecret("GEMINI_API_KEY");
    const res = await fetchWithRetry("Gemini", key, `${BASE}/${model()}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    const data = ((await res.json()) as GeminiReply).candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    const audio = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
    if (!audio.length) throw new Error(`Gemini sent no audio for voice "${voice}" (the text may have been blocked).`);
    // Newer models may already answer a WAV file; older ones answer raw PCM.
    const wav = audio.toString("ascii", 0, 4) === "RIFF" ? audio : pcmToWav(audio);
    await mkdir(dirname(outFile), { recursive: true });
    const tmp = `${outFile}.part`;
    await writeFile(tmp, wav);
    await rename(tmp, outFile);
  },

  async listVoices(): Promise<VoiceInfo[]> {
    return GEMINI_VOICES.map((name) => ({ name, locale: "multilingual", gender: "", langs: ["*"] }));
  },
};
