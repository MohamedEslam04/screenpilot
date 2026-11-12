import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retry } from "../src/voice/http.js";
import { elevenLabsProvider, resetElevenLabsVoices } from "../src/voice/elevenlabs.js";
import { getProvider } from "../src/voice/index.js";

const KEY = "xi-test-key-0123456789";
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
let dir: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, key: process.env.ELEVENLABS_API_KEY, model: process.env.ELEVENLABS_MODEL_ID, base: process.env.ELEVENLABS_BASE_URL, voices: process.env.SCREENPILOT_VOICES_FILE };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const audio = (bytes = [1, 2, 3, 4]) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-eleven-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.ELEVENLABS_API_KEY = KEY;
  delete process.env.ELEVENLABS_MODEL_ID;
  delete process.env.ELEVENLABS_BASE_URL;
  process.env.SCREENPILOT_VOICES_FILE = join(dir, "voices.json");
  retry.delayMs = 0;
  resetElevenLabsVoices();
});
afterEach(() => {
  vi.unstubAllGlobals();
  restore("XDG_CONFIG_HOME", saved.xdg);
  restore("ELEVENLABS_API_KEY", saved.key);
  restore("ELEVENLABS_MODEL_ID", saved.model);
  restore("ELEVENLABS_BASE_URL", saved.base);
  restore("SCREENPILOT_VOICES_FILE", saved.voices);
  retry.delayMs = 800;
});

describe("elevenlabs voice", () => {
  it("is registered, mp3, two at a time", () => {
    expect(getProvider("elevenlabs")).toBe(elevenLabsProvider);
    expect(elevenLabsProvider.ext?.("x") ?? "mp3").toBe("mp3");
    expect(elevenLabsProvider.concurrency).toBe(2);
  });

  it("posts the text with the key header and writes the audio", async () => {
    const fetchMock = vi.fn(async () => audio());
    vi.stubGlobal("fetch", fetchMock);
    const out = join(dir, "a.mp3");
    await elevenLabsProvider.synthesize("Hello there", VOICE_ID, "+0%", out);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe(KEY);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello there", model_id: "eleven_multilingual_v2" });
    expect([...(await readFile(out))]).toEqual([1, 2, 3, 4]);
  });

  it("sends the speed from the rate, clamped to what the API accepts", async () => {
    const fetchMock = vi.fn(async () => audio());
    vi.stubGlobal("fetch", fetchMock);
    await elevenLabsProvider.synthesize("a", VOICE_ID, "+10%", join(dir, "b.mp3"));
    await elevenLabsProvider.synthesize("a", VOICE_ID, "+60%", join(dir, "c.mp3"));
    await elevenLabsProvider.synthesize("a", VOICE_ID, "-60%", join(dir, "d.mp3"));
    const speeds = fetchMock.mock.calls.map((c) => JSON.parse(((c as unknown as [string, RequestInit])[1].body as string)).voice_settings?.speed);
    expect(speeds).toEqual([1.1, 1.2, 0.7]);
  });

  it("uses the model from the environment and puts it in the cache key", async () => {
    process.env.ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
    const fetchMock = vi.fn(async () => audio());
    vi.stubGlobal("fetch", fetchMock);
    await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "e.mp3"));
    expect(JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).model_id).toBe("eleven_flash_v2_5");
    expect(elevenLabsProvider.cacheKey?.(VOICE_ID)).toContain("eleven_flash_v2_5");
    expect(elevenLabsProvider.cacheKey?.(VOICE_ID)).not.toContain(KEY);
  });

  it("resolves a voice name through /v1/voices once per process", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/v1/voices") ? json({ voices: [{ voice_id: VOICE_ID, name: "Rachel", labels: { gender: "female" } }] }) : audio(),
    );
    vi.stubGlobal("fetch", fetchMock);
    await elevenLabsProvider.synthesize("a", "rachel", "+0%", join(dir, "f.mp3"));
    await elevenLabsProvider.synthesize("b", "Rachel", "+0%", join(dir, "g.mp3"));
    const urls = fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls.filter((u) => u === "https://api.elevenlabs.io/v1/voices")).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`))).toHaveLength(2);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "xi-api-key": KEY });
  });

  it("lists the known names when a voice name is not found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ voices: [{ voice_id: VOICE_ID, name: "Rachel" }] })));
    await expect(elevenLabsProvider.synthesize("a", "Nobody", "+0%", join(dir, "h.mp3"))).rejects.toThrow(/Nobody.*Rachel/s);
  });

  it("lists voices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ voices: [{ voice_id: VOICE_ID, name: "Rachel", labels: { gender: "female", accent: "american" }, verified_languages: [{ language: "en", locale: "en-US" }] }] }),
      ),
    );
    expect(await elevenLabsProvider.listVoices()).toEqual([{ name: "Rachel", locale: "en-US", gender: "female", langs: ["en"] }]);
  });

  it("retries a 429 and a 5xx, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ detail: { status: "too_many_concurrent_requests" } }, 429))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(audio());
    vi.stubGlobal("fetch", fetchMock);
    await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "i.mp3"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after three tries with the status and no key in the message", async () => {
    const fetchMock = vi.fn(async () => new Response(`rate limited for ${KEY}`, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "j.mp3")).catch((e: Error) => e);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((err as Error).message).toMatch(/ElevenLabs.*429/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("does not retry a 401 and keeps the key out of the error", async () => {
    const fetchMock = vi.fn(async () => json({ detail: { status: "invalid_api_key", message: `Invalid API key ${KEY}` } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const err = await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "k.mp3")).catch((e: Error) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("keeps the key out of a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error(`connect failed (xi-api-key: ${KEY})`))));
    const err = await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "l.mp3")).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("names the env var and file when the key is missing, before any request", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "m.mp3"))).rejects.toThrow(/ELEVENLABS_API_KEY.*secrets\.json/s);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes no file when the audio is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })));
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "n.mp3"))).rejects.toThrow(/no audio/);
  });
});

describe("elevenlabs voice: region and base URL", () => {
  const sent = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => (c as unknown as [string])[0]);

  it("talks to the EU residency host when ELEVENLABS_BASE_URL says so", async () => {
    process.env.ELEVENLABS_BASE_URL = "eu";
    const fetchMock = vi.fn(async () => audio());
    vi.stubGlobal("fetch", fetchMock);
    await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r1.mp3"));
    expect(sent(fetchMock)[0]).toBe(`https://api.eu.residency.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`);
  });

  it("accepts a gateway address with a path prefix, a trailing slash and a pasted /v1", async () => {
    process.env.ELEVENLABS_BASE_URL = "https://gw.example.com/eleven/v1/";
    const fetchMock = vi.fn(async (url: string) => (url.includes("/v1/voices") ? json({ voices: [{ voice_id: VOICE_ID, name: "Rachel" }] }) : audio()));
    vi.stubGlobal("fetch", fetchMock);
    await elevenLabsProvider.synthesize("a", "Rachel", "+0%", join(dir, "r2.mp3"));
    expect(sent(fetchMock)).toEqual([
      "https://gw.example.com/eleven/v1/voices",
      `https://gw.example.com/eleven/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
    ]);
  });

  it("keeps the cache key of the default host and changes it for another host", () => {
    const base = elevenLabsProvider.cacheKey?.(VOICE_ID);
    expect(base).toBe("eleven_multilingual_v2");
    process.env.ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/";
    expect(elevenLabsProvider.cacheKey?.(VOICE_ID)).toBe(base);
    process.env.ELEVENLABS_BASE_URL = "eu";
    expect(elevenLabsProvider.cacheKey?.(VOICE_ID)).toBe(`${base}@api.eu.residency.elevenlabs.io`);
  });

  it("fails before any request when the base URL is bad", async () => {
    process.env.ELEVENLABS_BASE_URL = "http://evil.example.com";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r3.mp3"))).rejects.toThrow(/ELEVENLABS_BASE_URL.*https/s);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a 401 on the default host: the key may belong to another region", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: { status: "invalid_api_key", message: "Invalid API key" } }, 401)));
    const err = (await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r4.mp3")).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/401/);
    expect(err.message).toMatch(/api\.elevenlabs\.io/);
    expect(err.message).toMatch(/ELEVENLABS_BASE_URL=eu/);
    expect(err.message).not.toContain(KEY);
  });

  it("explains a 401 on another host: the key must belong to that region", async () => {
    process.env.ELEVENLABS_BASE_URL = "eu";
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: { status: "invalid_api_key" } }, 401)));
    const err = (await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r5.mp3")).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/api\.eu\.residency\.elevenlabs\.io/);
    expect(err.message).toMatch(/that region|same region/);
  });

  it("says credits are used up for quota_exceeded and does not retry it", async () => {
    const fetchMock = vi.fn(async () => json({ detail: { status: "quota_exceeded", message: "Only 3 left on this plan" } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r6.mp3")).catch((e: Error) => e)) as Error;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/credits/i);
    expect(err.message).not.toMatch(/ELEVENLABS_BASE_URL/);
  });

  it("does not retry a 429 that is a quota, but retries a concurrency 429", async () => {
    const quota = vi.fn(async () => json({ detail: { status: "quota_exceeded" } }, 429));
    vi.stubGlobal("fetch", quota);
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r7.mp3"))).rejects.toThrow(/credits/i);
    expect(quota).toHaveBeenCalledTimes(1);
  });

  it("explains 402 and 422", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "payment_required" }, 402)));
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r8.mp3"))).rejects.toThrow(/402.*(plan|subscription|paid)/is);
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: [{ msg: "voice not found" }] }, 422)));
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r9.mp3"))).rejects.toThrow(/422.*(voice|model).*(account|region)/is);
  });

  it("refuses a 200 that is not audio (a gateway or login page) and writes no file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })));
    const out = join(dir, "r10.mp3");
    await expect(elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", out)).rejects.toThrow(/not audio.*text\/html.*ELEVENLABS_BASE_URL/is);
    await expect(readFile(out)).rejects.toThrow();
  });

  it("waits for Retry-After on a 429 (capped) before the next try", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
        .mockResolvedValueOnce(audio());
      vi.stubGlobal("fetch", fetchMock);
      const done = elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r11.mp3"));
      await vi.advanceTimersByTimeAsync(1500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      await done;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrubs the key from a header echoed by a gateway", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request, headers: xi-api-key: secret-from-gateway-123", { status: 400 })));
    const err = (await elevenLabsProvider.synthesize("a", VOICE_ID, "+0%", join(dir, "r12.mp3")).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain("secret-from-gateway-123");
  });
});
