import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiProvider, pcmToWav } from "../src/voice/gemini.js";
import { retry } from "../src/voice/http.js";
import { getProvider, voiceMatchesLang } from "../src/voice/index.js";

const KEY = "AIza-test-key-0123456789";
let dir: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_TTS_MODEL };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // four 16-bit samples
const reply = (data: Buffer | string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: typeof data === "string" ? data : data.toString("base64") } }] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-gemini-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.GEMINI_API_KEY = KEY;
  delete process.env.GEMINI_TTS_MODEL;
  retry.delayMs = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  restore("XDG_CONFIG_HOME", saved.xdg);
  restore("GEMINI_API_KEY", saved.key);
  restore("GEMINI_TTS_MODEL", saved.model);
  retry.delayMs = 800;
});

describe("pcmToWav", () => {
  it("prefixes a 44-byte RIFF header for 24 kHz 16-bit mono", () => {
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });
});

describe("gemini voice", () => {
  it("is registered and writes wav", () => {
    expect(getProvider("gemini")).toBe(geminiProvider);
    expect(geminiProvider.ext?.("Kore")).toBe("wav");
  });

  it("posts the documented request and wraps the PCM in a WAV file", async () => {
    const fetchMock = vi.fn(async () => reply(pcm));
    vi.stubGlobal("fetch", fetchMock);
    const out = join(dir, "a.wav");
    await geminiProvider.synthesize("Say this", "Kore", "+0%", out);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(url).not.toContain(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      contents: [{ parts: [{ text: "Say this" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
    const wav = await readFile(out);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("keeps audio that already has a WAV header", async () => {
    const wav = pcmToWav(pcm);
    vi.stubGlobal("fetch", vi.fn(async () => reply(wav)));
    const out = join(dir, "b.wav");
    await geminiProvider.synthesize("x", "Kore", "+0%", out);
    expect((await readFile(out)).equals(wav)).toBe(true);
  });

  it("uses the model from the environment and puts it in the cache key", async () => {
    process.env.GEMINI_TTS_MODEL = "gemini-2.5-pro-preview-tts";
    const fetchMock = vi.fn(async () => reply(pcm));
    vi.stubGlobal("fetch", fetchMock);
    await geminiProvider.synthesize("x", "Puck", "+0%", join(dir, "c.wav"));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("/models/gemini-2.5-pro-preview-tts:generateContent");
    expect(geminiProvider.cacheKey?.("Puck")).toContain("gemini-2.5-pro-preview-tts");
    expect(geminiProvider.cacheKey?.("Puck")).not.toContain(KEY);
  });

  it("lists the prebuilt voices", async () => {
    const voices = await geminiProvider.listVoices();
    expect(voices.map((v) => v.name)).toEqual(expect.arrayContaining(["Kore", "Puck", "Zephyr", "Sulafat"]));
    expect(voices).toHaveLength(30);
    expect(voices.every((v) => voiceMatchesLang(v, "ar-EG"))).toBe(true); // any language
  });

  it("retries a 429 then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429 })).mockResolvedValueOnce(reply(pcm));
    vi.stubGlobal("fetch", fetchMock);
    await geminiProvider.synthesize("x", "Kore", "+0%", join(dir, "d.wav"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the key out of errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`API key not valid: ${KEY}`, { status: 400 })));
    const err = await geminiProvider.synthesize("x", "Kore", "+0%", join(dir, "e.wav")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Gemini.*400/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("fails clearly when the answer has no audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "OTHER" }] }), { status: 200 })));
    await expect(geminiProvider.synthesize("x", "Kore", "+0%", join(dir, "f.wav"))).rejects.toThrow(/no audio/);
  });

  it("names the env var and file when the key is missing, before any request", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(geminiProvider.synthesize("x", "Kore", "+0%", join(dir, "g.wav"))).rejects.toThrow(/GEMINI_API_KEY.*secrets\.json/s);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
