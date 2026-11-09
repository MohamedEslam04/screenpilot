import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateSequence } from "../src/sequence/estimate.js";
import { estimateStoryboard } from "../src/voice/estimate.js";
import { elevenLabsProvider, resetElevenLabsVoices } from "../src/voice/elevenlabs.js";
import { geminiProvider } from "../src/voice/gemini.js";
import { retry } from "../src/voice/http.js";
import { clipFile, synthesizeLines } from "../src/voice/index.js";
import { formatSpend, NO_SPEND_ENV, readSpend, recordSpend, spendFile, summarizeSpend, usdPerCredit } from "../src/voice/spend.js";
import { makeVideo } from "./fixtures/video.js";

const EKEY = "xi-test-key-0123456789";
const GKEY = "gm-test-key-9876543210";
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
let dir: string;
const names = ["XDG_CONFIG_HOME", "ELEVENLABS_API_KEY", "GEMINI_API_KEY", NO_SPEND_ENV, "SCREENPILOT_VOICES_FILE"];
const saved: Record<string, string | undefined> = {};

const audio = (n = 16000) => new Response(new Uint8Array(n), { status: 200 });
const geminiReply = (pcmBytes: number) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(pcmBytes, 1).toString("base64") } }] } }] }), { status: 200 });

beforeEach(async () => {
  for (const n of names) saved[n] = process.env[n];
  dir = await mkdtemp(join(tmpdir(), "sp-spend-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.ELEVENLABS_API_KEY = EKEY;
  process.env.GEMINI_API_KEY = GKEY;
  delete process.env.SCREENPILOT_VOICES_FILE;
  retry.delayMs = 0;
  resetElevenLabsVoices();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  retry.delayMs = 800;
});

describe("spend ledger file", () => {
  it("appends rows with t, provider, model, voice, chars, audio_s, credits, usd to an explicit file", async () => {
    const file = join(dir, "l.jsonl");
    await recordSpend({ provider: "elevenlabs", model: "m", voice: "v", chars: 1000, audio_s: 60 }, file);
    const [row] = await readSpend({ file });
    expect(Object.keys(row!).sort()).toEqual(["audio_s", "chars", "credits", "model", "provider", "t", "usd", "voice"]);
    expect(row).toMatchObject({ provider: "elevenlabs", model: "m", voice: "v", chars: 1000, audio_s: 60, credits: 1000 });
    expect(row!.usd).toBeCloseTo(1000 * usdPerCredit("elevenlabs"), 6);
    expect(Number.isNaN(Date.parse(row!.t))).toBe(false);
  });

  it("is switched off by SCREENPILOT_NO_SPEND unless a file is given (the test suite sets it)", async () => {
    expect(process.env[NO_SPEND_ENV]).toBeTruthy(); // vitest.config.ts
    await recordSpend({ provider: "elevenlabs", model: "m", voice: "v", chars: 5, audio_s: 1 });
    expect(await readSpend({ file: spendFile() })).toEqual([]);
  });

  it("never throws when it cannot write", async () => {
    await expect(recordSpend({ provider: "gemini", model: "m", voice: "v", chars: 1, audio_s: 1 }, join(dir, "x\0y", "l.jsonl"))).resolves.toBeUndefined();
  });

  it("prices credits per provider: ElevenLabs characters, Gemini audio tokens (25 per second), others free", async () => {
    const file = join(dir, "l.jsonl");
    await recordSpend({ provider: "gemini", model: "m", voice: "Kore", chars: 40, audio_s: 4 }, file);
    await recordSpend({ provider: "edge", model: "", voice: "x", chars: 40, audio_s: 4 }, file);
    const rows = await readSpend({ file });
    expect(rows[0]).toMatchObject({ credits: 100 });
    expect(rows[0]!.usd).toBeCloseTo(100 * usdPerCredit("gemini"), 6);
    expect(rows[1]).toMatchObject({ credits: 0, usd: 0 });
  });

  it("takes usdPerCredit from voices.json and falls back to the default when that file is broken", async () => {
    const voices = join(dir, "voices.json");
    process.env.SCREENPILOT_VOICES_FILE = voices;
    await writeFile(voices, JSON.stringify({ spend: { usdPerCredit: { elevenlabs: 0.001 } } }));
    expect(usdPerCredit("elevenlabs")).toBe(0.001);
    await writeFile(voices, "{ not json");
    expect(usdPerCredit("elevenlabs")).toBeGreaterThan(0);
    const file = join(dir, "l.jsonl");
    await recordSpend({ provider: "elevenlabs", model: "m", voice: "v", chars: 10, audio_s: 1 }, file);
    expect(await readSpend({ file })).toHaveLength(1);
  });

  it("reads rows since a date, skips torn lines and totals by provider", async () => {
    const file = join(dir, "l.jsonl");
    const row = (t: string, provider: string, chars: number, usd: number) => JSON.stringify({ t, provider, model: "m", voice: "v", chars, audio_s: 2, credits: chars, usd });
    await writeFile(file, [row("2026-10-01T10:00:00Z", "elevenlabs", 100, 0.03), "{broken", row("2026-11-05T10:00:00Z", "elevenlabs", 200, 0.06), row("2026-11-06T10:00:00Z", "gemini", 50, 0.01)].join("\n") + "\n");
    expect(await readSpend({ file })).toHaveLength(3);
    const recent = await readSpend({ file, since: new Date("2026-11-01T00:00:00Z") });
    expect(recent).toHaveLength(2);
    const sum = summarizeSpend(recent);
    expect(sum).toMatchObject({ requests: 2, chars: 250, audio_s: 4, credits: 250 });
    expect(sum.usd).toBeCloseTo(0.07, 6);
    expect(sum.byProvider.elevenlabs).toMatchObject({ requests: 1, chars: 200 });
    expect(formatSpend(sum)).toMatch(/elevenlabs/);
    expect(formatSpend(summarizeSpend([]))).toMatch(/nothing/i);
  });
});

describe("billed requests are recorded, nothing else", () => {
  it("ElevenLabs: one row per successful request, with the voice, model and character count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audio(16000)));
    delete process.env[NO_SPEND_ENV];
    await elevenLabsProvider.synthesize("Hello there", VOICE_ID, "+0%", join(dir, "a.mp3"));
    const rows = await readSpend({ file: spendFile() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "elevenlabs", model: "eleven_multilingual_v2", voice: VOICE_ID, chars: 11, credits: 11 });
    expect(rows[0]!.audio_s).toBeCloseTo(1, 1); // 16000 bytes of mp3_44100_128
  });

  it("Gemini: one row, audio seconds from the 24 kHz 16-bit PCM", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => geminiReply(96000)));
    delete process.env[NO_SPEND_ENV];
    await geminiProvider.synthesize("Hi", "Kore", "+0%", join(dir, "a.wav"));
    const rows = await readSpend({ file: spendFile() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "gemini", voice: "Kore", chars: 2, audio_s: 2, credits: 50 });
  });

  it("a failed request, a retried 429 and an empty reply record nothing; the retry that succeeds records once", async () => {
    delete process.env[NO_SPEND_ENV];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(elevenLabsProvider.synthesize("x", VOICE_ID, "+0%", join(dir, "a.mp3"))).rejects.toThrow(/401/);
    vi.stubGlobal("fetch", vi.fn(async () => audio(0)));
    await expect(elevenLabsProvider.synthesize("x", VOICE_ID, "+0%", join(dir, "b.mp3"))).rejects.toThrow(/no audio/);
    expect(await readSpend({ file: spendFile() })).toEqual([]);

    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++n < 3 ? new Response("slow down", { status: 429 }) : audio())));
    await elevenLabsProvider.synthesize("x", VOICE_ID, "+0%", join(dir, "c.mp3"));
    expect(await readSpend({ file: spendFile() })).toHaveLength(1);
  });

  it("a cache hit records nothing and sends nothing", async () => {
    delete process.env[NO_SPEND_ENV];
    const fetchMock = vi.fn(async () => audio());
    vi.stubGlobal("fetch", fetchMock);
    const voiceDir = join(dir, "voice");
    const line = { text: "cached line", voice: VOICE_ID, rate: "+0%" };
    const file = clipFile(elevenLabsProvider, line, voiceDir);
    await mkdir(voiceDir, { recursive: true });
    await writeFile(file, "x");
    await writeFile(`${file}.dur`, "1.5");
    const clips = await synthesizeLines("elevenlabs", [line], voiceDir);
    expect(clips[0]!.duration).toBe(1.5);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readSpend({ file: spendFile() })).toEqual([]);
  });

  it("never puts a key in the ledger, an error or a log line", async () => {
    delete process.env[NO_SPEND_ENV];
    const logged: string[] = [];
    const spies = (["log", "error", "warn"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.join(" "))));
    vi.stubGlobal("fetch", vi.fn(async () => audio()));
    await elevenLabsProvider.synthesize("secret test", VOICE_ID, "+0%", join(dir, "a.mp3"));
    vi.stubGlobal("fetch", vi.fn(async () => geminiReply(48000)));
    await geminiProvider.synthesize("secret test", "Kore", "+0%", join(dir, "a.wav"));
    // A service that echoes the key back in its error.
    const errors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(`bad key ${url.includes("elevenlabs") ? EKEY : GKEY}`, { status: 400 })));
    for (const p of [() => elevenLabsProvider.synthesize("x", VOICE_ID, "+0%", join(dir, "z.mp3")), () => geminiProvider.synthesize("x", "Kore", "+0%", join(dir, "z.wav"))]) {
      await p().catch((e: Error) => errors.push(e.message));
    }
    spies.forEach((s) => s.mockRestore());
    const ledger = await readFile(spendFile(), "utf8");
    expect(ledger.trim().split("\n")).toHaveLength(2);
    for (const secret of [EKEY, GKEY]) {
      expect(ledger).not.toContain(secret);
      expect(errors.join("\n")).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }
    expect(errors).toHaveLength(2);
  });
});

async function listAll(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) out.push(join(e.parentPath, e.name));
  return out.sort();
}

describe("dry run estimate", () => {
  async function board(extra: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), "sp-dry-"));
    makeVideo(join(root, "rec.mp4"), 3);
    await writeFile(
      join(root, "demo.json"),
      JSON.stringify({
        source: "rec.mp4",
        voice: { provider: "elevenlabs", name: VOICE_ID },
        narration: [
          { at: 0.2, text: "First line here." },
          { at: 1, text: "Second line." },
          { at: 2, text: "Ready made", audio: "x.mp3" },
        ],
        ...extra,
      }),
    );
    return root;
  }

  it("counts lines, characters and estimated USD without sending a request or writing anything", async () => {
    const fetchMock = vi.fn(async () => audio());
    vi.stubGlobal("fetch", fetchMock);
    const root = await board();
    const before = await listAll(root);
    const e = await estimateStoryboard(join(root, "demo.json"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listAll(root)).toEqual(before);
    expect(await listAll(dir)).toEqual([]); // no ledger row, no config
    expect(e).toMatchObject({ dryRun: true, provider: "elevenlabs", lines: 2, cachedLines: 0, chars: "First line here.".length + "Second line.".length, credits: 28 });
    expect(e.estimatedUsd).toBeCloseTo(28 * usdPerCredit("elevenlabs"), 6);
  });

  it("leaves out lines whose clip is already in the cache", async () => {
    const root = await board();
    const voiceDir = join(root, ".screenpilot-cache", "voice");
    await mkdir(voiceDir, { recursive: true });
    await writeFile(clipFile(elevenLabsProvider, { text: "Second line.", voice: VOICE_ID, rate: "+0%" }, voiceDir), "x");
    const e = await estimateStoryboard(join(root, "demo.json"));
    expect(e).toMatchObject({ lines: 1, cachedLines: 1, chars: "First line here.".length });
  });

  it("costs nothing for a voice that is free, and still counts lines and characters", async () => {
    const root = await board({ voice: { provider: "edge", name: "en-US-AndrewNeural" } });
    expect(await estimateStoryboard(join(root, "demo.json"))).toMatchObject({ provider: "edge", lines: 2, estimatedUsd: 0, credits: 0 });
  });

  it("estimates Gemini from the spoken length", async () => {
    const root = await board({ voice: { provider: "gemini", name: "Kore" } });
    const e = await estimateStoryboard(join(root, "demo.json"));
    expect(e.credits).toBeGreaterThan(0);
    expect(e.estimatedUsd).toBeCloseTo(e.credits * usdPerCredit("gemini"), 6);
  });

  it("a sequence adds its parts (only the range of each), counts a shared clip once, and writes no build folder", async () => {
    const root = await board();
    const seq = join(root, "seq.json");
    await writeFile(seq, JSON.stringify({ parts: [{ storyboard: "demo.json", to: 0.6 }, { storyboard: "demo.json", from: 0.6 }] }));
    const before = await listAll(root);
    const e = await estimateSequence(seq);
    expect(await listAll(root)).toEqual(before);
    expect(e).toMatchObject({ dryRun: true, lines: 2, chars: "First line here.".length + "Second line.".length });
    expect(e.parts).toHaveLength(2);
  });
});
