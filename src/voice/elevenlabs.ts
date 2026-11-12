import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baseUrlFor, hostOf, resolveEndpoint } from "./endpoint.js";
import { expectContentType, fetchWithRetry, readJson, redact, type FetchOptions } from "./http.js";
import type { VoiceInfo, VoiceProvider } from "./index.js";
import { getSecret } from "./secrets.js";
import { countChars, recordSpend } from "./spend.js";
import { rateToSpeed } from "./text.js";

// ElevenLabs text to speech (https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
// Needs ELEVENLABS_API_KEY. The voice name is a voice id or the name of a voice on the account.
// An account with data residency (EU, India, Singapore) or a company gateway has its own host:
// ELEVENLABS_BASE_URL or providers.elevenlabs.baseUrl in voices.json (see endpoint.ts).

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

const statusOf = (body: string): string => /"status"\s*:\s*"([a-z_]+)"/i.exec(body)?.[1]?.toLowerCase() ?? "";

/** What a failed request means and what to do about it, so the user is not left with a raw JSON reply. */
export function explainElevenLabs(base: string): FetchOptions {
  const isDefault = resolveEndpoint("elevenlabs").isDefault;
  const host = hostOf(base);
  const quota = (body: string) => statusOf(body) === "quota_exceeded" || /quota_exceeded/i.test(body);
  return {
    fatal: (_status, body) => quota(body),
    hint: (status, body) => {
      if (quota(body)) return "your ElevenLabs credits are used up: add credits, change plan or wait for the monthly reset";
      if (status === 401) {
        if (statusOf(body) === "missing_permissions") return "the key lacks a permission for this call: allow text to speech (and voices read, to use voice names) on the key";
        return isDefault
          ? `${host} refused the key. A key of an account with data residency only works on its own host: set ELEVENLABS_BASE_URL=eu (or in, sg, us, or the full address) if that is your case, otherwise check the key`
          : `${host} refused the key: it must belong to an account of that same region (check ELEVENLABS_BASE_URL and the key)`;
      }
      if (status === 402) return "needs a paid plan or a payment method: check your ElevenLabs subscription";
      if (status === 403) return "the key may not be allowed to do this; check its permissions";
      if (status === 404 && !isDefault) return `${host} did not know this path: check ELEVENLABS_BASE_URL (a gateway must forward /v1/...)`;
      if (status === 422) return "the voice id or model is not valid for this account; voice ids and models can differ between regions";
      return undefined;
    },
  };
}

const notAudioHint = (base: string) => `${base} may be a gateway or login page, not the API: check ELEVENLABS_BASE_URL`;

const voices = new Map<string, Promise<ApiVoice[]>>();

/** Voices of the account, fetched once per process and host (a failed fetch is tried again next time). */
function accountVoices(): Promise<ApiVoice[]> {
  const base = baseUrlFor("elevenlabs");
  let list = voices.get(base);
  if (!list) {
    list = (async () => {
      const key = getSecret("ELEVENLABS_API_KEY");
      const res = await fetchWithRetry("ElevenLabs", key, `${base}/v1/voices`, { headers: { "xi-api-key": key } }, explainElevenLabs(base));
      return ((await readJson<{ voices?: ApiVoice[] }>("ElevenLabs", res, key, notAudioHint(base))).voices) ?? [];
    })().catch((err) => {
      voices.delete(base);
      throw err;
    });
    voices.set(base, list);
  }
  return list;
}

export function resetElevenLabsVoices(): void {
  voices.clear();
}

/** One cheap authenticated request to the resolved host, for `doctor`. Never costs credits. */
export async function checkElevenLabs(): Promise<{ ok: boolean; detail: string }> {
  const { url: base, source } = resolveEndpoint("elevenlabs");
  const host = hostOf(base);
  const via = source === "default" ? "default host" : `from ${source === "env" ? "ELEVENLABS_BASE_URL" : "voices.json"}`;
  const key = getSecret("ELEVENLABS_API_KEY");
  let res: Response;
  try {
    res = await fetch(`${base}/v1/models`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, detail: `${host} (${via}) could not be reached: ${redact((err as Error).message, key)}` };
  }
  if (res.ok) return { ok: true, detail: `key accepted by ${host} (${via})` };
  const body = redact((await res.text().catch(() => "")).trim().slice(0, 200), key);
  if (res.status === 401 && statusOf(body) === "missing_permissions") return { ok: true, detail: `key accepted by ${host} (${via}), but it is a restricted key` };
  const hint = explainElevenLabs(base).hint?.(res.status, body);
  return { ok: false, detail: `${host} (${via}) answered ${res.status}${body ? `: ${body}` : ""}${hint ? ` (${hint})` : ""}` };
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
  // A clip made through another host (region) is another key; the default host keeps the plain model, so clips made before stay valid.
  cacheKey: () => {
    const { url, isDefault } = resolveEndpoint("elevenlabs");
    return isDefault ? model() : `${model()}@${hostOf(url)}`;
  },

  async synthesize(text, voice, rate, outFile) {
    const base = baseUrlFor("elevenlabs");
    const key = getSecret("ELEVENLABS_API_KEY");
    const id = await voiceId(voice);
    // voice_settings.speed takes 0.7 to 1.2. It is only sent for a changed rate, because
    // settings sent with a request replace the ones stored for the voice.
    const speed = Math.min(1.2, Math.max(0.7, rateToSpeed(rate)));
    const res = await fetchWithRetry("ElevenLabs", key, `${base}/v1/text-to-speech/${id}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model(), ...(speed === 1 ? {} : { voice_settings: { speed } }) }),
    }, explainElevenLabs(base));
    await expectContentType("ElevenLabs", res, key, "audio/", notAudioHint(base));
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
