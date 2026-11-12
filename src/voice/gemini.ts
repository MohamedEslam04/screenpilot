import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baseUrlFor, hostOf, resolveEndpoint } from "./endpoint.js";
import { fetchWithRetry, readJson, redact, type FetchOptions } from "./http.js";
import type { VoiceInfo, VoiceProvider } from "./index.js";
import { getSecret } from "./secrets.js";
import { countChars, recordSpend } from "./spend.js";

// Gemini API text to speech (https://ai.google.dev/gemini-api/docs/speech-generation).
// Needs GEMINI_API_KEY. The voice name is one of the prebuilt voices below.
// A company gateway (or a regional proxy) has its own host: GEMINI_BASE_URL or
// providers.gemini.baseUrl in voices.json (see endpoint.ts).

const MODELS_PATH = "/v1beta/models";
const DEFAULT_MODEL = "gemini-3.8-flash-tts";
// Current TTS model per https://aistudio.google.com/docs/speech-generation (checked 2026-11-09; the older gemini-2.5-flash-preview-tts is no longer listed there). Not tried against a live account.
const SAMPLE_RATE = 24000; // the TTS models answer 24 kHz, 16-bit, mono PCM

// The 30 prebuilt voices of the docs. They speak every supported language; the language is detected from the text.
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

const model = () => process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;

/** What a failed request means and what to do about it. */
export function explainGemini(base: string): FetchOptions {
  const host = hostOf(base);
  return {
    hint: (status, body) => {
      if (/location is not supported/i.test(body)) return `${host} is not available where you are: set GEMINI_BASE_URL to a gateway that is`;
      if (/api key not valid|api_key_invalid|permission_denied/i.test(body) || status === 401 || status === 403) {
        return `${host} refused the key: check the key, and GEMINI_BASE_URL if you use a gateway`;
      }
      if (status === 404 && !resolveEndpoint("gemini").isDefault) return `${host} did not know this path: check GEMINI_BASE_URL (a gateway must forward ${MODELS_PATH}/...)`;
      return undefined;
    },
  };
}

/** One cheap authenticated request to the resolved host, for `doctor`. */
export async function checkGemini(): Promise<{ ok: boolean; detail: string }> {
  const { url: base, source } = resolveEndpoint("gemini");
  const host = hostOf(base);
  const via = source === "default" ? "default host" : `from ${source === "env" ? "GEMINI_BASE_URL" : "voices.json"}`;
  const key = getSecret("GEMINI_API_KEY");
  let res: Response;
  try {
    res = await fetch(`${base}${MODELS_PATH}?pageSize=1`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, detail: `${host} (${via}) could not be reached: ${redact((err as Error).message, key)}` };
  }
  if (res.ok) return { ok: true, detail: `key accepted by ${host} (${via})` };
  const body = redact((await res.text().catch(() => "")).trim().slice(0, 200), key);
  const hint = explainGemini(base).hint?.(res.status, body);
  return { ok: false, detail: `${host} (${via}) answered ${res.status}${body ? `: ${body}` : ""}${hint ? ` (${hint})` : ""}` };
}

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
  // Another host is another key; the default host keeps the plain model, so clips made before stay valid.
  cacheKey: () => {
    const { url, isDefault } = resolveEndpoint("gemini");
    return isDefault ? model() : `${model()}@${hostOf(url)}`;
  },

  // The API has no speed setting, so `rate` is ignored (a style hint in the text could do it, but would be read aloud).
  async synthesize(text, voice, _rate, outFile) {
    const base = baseUrlFor("gemini");
    const key = getSecret("GEMINI_API_KEY");
    const res = await fetchWithRetry("Gemini", key, `${base}${MODELS_PATH}/${model()}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    }, explainGemini(base)).catch((err: Error) => {
      // Model names change: say how to pick another one instead of leaving a bare 404.
      if (/answered 404/.test(err.message)) {
        throw new Error(`${err.message} (model "${model()}" not found: set GEMINI_TTS_MODEL to a TTS model listed at https://aistudio.google.com/docs/speech-generation)`);
      }
      throw err;
    });
    const data = (await readJson<GeminiReply>("Gemini", res, key, `${base} may be a gateway or login page, not the API: check GEMINI_BASE_URL`)).candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    const audio = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
    if (!audio.length) throw new Error(`Gemini sent no audio for voice "${voice}" (the text may have been blocked).`);
    // Newer models may already answer a WAV file; older ones answer raw PCM.
    const wav = audio.toString("ascii", 0, 4) === "RIFF" ? audio : pcmToWav(audio);
    // The request is billed from here on; the WAV is 16-bit mono after a 44-byte header.
    await recordSpend({ provider: "gemini", model: model(), voice, chars: countChars(text), audio_s: Math.max(0, wav.length - 44) / (SAMPLE_RATE * 2) });
    await mkdir(dirname(outFile), { recursive: true });
    const tmp = `${outFile}.part`;
    await writeFile(tmp, wav);
    await rename(tmp, outFile);
  },

  async listVoices(): Promise<VoiceInfo[]> {
    return GEMINI_VOICES.map((name) => ({ name, locale: "multilingual", gender: "", langs: ["*"] }));
  },
};
