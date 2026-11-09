import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchWithRetry } from "./http.js";
import type { VoiceInfo, VoiceProvider } from "./index.js";
import { getSecret } from "./secrets.js";
import { countChars, recordSpend } from "./spend.js";
import { rateToSpeed } from "./text.js";

// ElevenLabs text to speech (https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
// Needs ELEVENLABS_API_KEY. The voice name is a voice id or the name of a voice on the account.

const BASE = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "eleven_multilingual_v2";
const OUTPUT_FORMAT = "mp3_44100_128";
const MP3_BITS_PER_SECOND = 128_000;
// A voice id is 20 letters and digits; anything else is looked up by name.
const VOICE_ID = /^[A-Za-z0-9]{20}$/;

interface ApiVoice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  verified_languages?: { language?: string; locale?: string }[];
}

const model = () => process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;

let voices: Promise<ApiVoice[]> | undefined;

/** Voices of the account, fetched once per process (a failed fetch is tried again next time). */
function accountVoices(): Promise<ApiVoice[]> {
  voices ??= (async () => {
    const key = getSecret("ELEVENLABS_API_KEY");
    const res = await fetchWithRetry("ElevenLabs", key, `${BASE}/v1/voices`, { headers: { "xi-api-key": key } });
    return ((await res.json()) as { voices?: ApiVoice[] }).voices ?? [];
  })().catch((err) => {
    voices = undefined;
    throw err;
  });
  return voices;
}

export function resetElevenLabsVoices(): void {
  voices = undefined;
}

async function voiceId(voice: string): Promise<string> {
  if (VOICE_ID.test(voice)) return voice;
  const all = await accountVoices();
  const found = all.find((v) => v.name.toLowerCase() === voice.toLowerCase() || v.voice_id === voice);
  if (found) return found.voice_id;
  throw new Error(`ElevenLabs has no voice "${voice}" on this account. Use a voice id or one of: ${all.map((v) => v.name).join(", ")}`);
}

export const elevenLabsProvider: VoiceProvider = {
  id: "elevenlabs",
  // The free plan allows 2 requests at once; more get a 429.
  concurrency: 2,

  // The voice name is already part of the key; the model changes the audio without changing it.
  cacheKey: () => model(),

  async synthesize(text, voice, rate, outFile) {
    const key = getSecret("ELEVENLABS_API_KEY");
    const id = await voiceId(voice);
    // voice_settings.speed takes 0.7 to 1.2. It is only sent for a changed rate, because
    // settings sent with a request replace the ones stored for the voice.
    const speed = Math.min(1.2, Math.max(0.7, rateToSpeed(rate)));
    const res = await fetchWithRetry("ElevenLabs", key, `${BASE}/v1/text-to-speech/${id}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model(), ...(speed === 1 ? {} : { voice_settings: { speed } }) }),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error(`ElevenLabs sent no audio for voice "${voice}".`);
    // The request is billed from here on; the clip is mp3_44100_128, so its length follows from its size.
    await recordSpend({ provider: "elevenlabs", model: model(), voice, chars: countChars(text), audio_s: (audio.length * 8) / MP3_BITS_PER_SECOND });
    await mkdir(dirname(outFile), { recursive: true });
    const tmp = `${outFile}.part`;
    await writeFile(tmp, audio);
    await rename(tmp, outFile);
  },

  async listVoices(): Promise<VoiceInfo[]> {
    return (await accountVoices()).map((v) => {
      const langs = (v.verified_languages ?? []).map((l) => l.language).filter((l): l is string => !!l);
      return {
        name: v.name,
        locale: v.verified_languages?.find((l) => l.locale)?.locale ?? v.labels?.language ?? "multilingual",
        gender: v.labels?.gender ?? "",
        ...(langs.length ? { langs } : {}),
      };
    });
  },
};
