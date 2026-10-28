import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { createLocalProvider, LocalWorker, parseLocalVoice } from "../src/voice/local.js";

const fake = join(import.meta.dirname, "fixtures", "fake-tts-worker.mjs");
const launch = (env: NodeJS.ProcessEnv = {}) => () => ({ command: process.execPath, args: [fake], env });
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-local-"));
});

describe("parseLocalVoice", () => {
  it("splits model and voice", () => {
    expect(parseLocalVoice("voicetut:Sarah")).toEqual({ model: "voicetut", voice: "Sarah" });
    expect(parseLocalVoice("namaa")).toEqual({ model: "namaa", voice: null });
    expect(parseLocalVoice("voicetut")).toEqual({ model: "voicetut", voice: null });
  });
  it("rejects an unknown model and lists the real ones", () => {
    expect(() => parseLocalVoice("piper:amy")).toThrow(/Unknown local voice "piper:amy".*voicetut.*namaa/s);
  });
});

describe("local provider", () => {
  it("writes the audio file through the worker", async () => {
    const p = createLocalProvider(launch());
    const out = join(dir, "x.wav");
    await p.synthesize("Hello", "voicetut:Sarah", "+10%", out);
    expect((await stat(out)).size).toBeGreaterThan(44);
    await p.close?.();
  });

  it("keeps one worker for many lines", async () => {
    const p = createLocalProvider(launch());
    for (const n of [1, 2, 3]) await p.synthesize(`line ${n}`, "voicetut", "+0%", join(dir, `${n}.wav`));
    await p.close?.();
  });

  it("throws the worker's own message when a line fails", async () => {
    const p = createLocalProvider(launch());
    await expect(p.synthesize("Hi", "voicetut:Nobody", "+0%", join(dir, "n.wav"))).rejects.toThrow(/No voice Nobody.*Valid: Ahmed, Sarah/);
    await p.synthesize("Hi", "voicetut:Sarah", "+0%", join(dir, "ok.wav")); // still usable
    await p.close?.();
  });

  it("starts a new worker after close", async () => {
    const p = createLocalProvider(launch());
    await p.synthesize("a", "namaa", "+0%", join(dir, "1.wav"));
    await p.close?.();
    await p.synthesize("b", "namaa", "+0%", join(dir, "2.wav"));
    await p.close?.();
  });

  it("lists installed voices only, with their languages", async () => {
    const p = createLocalProvider(launch());
    const voices = await p.listVoices();
    expect(voices.map((v) => v.name)).toEqual(["voicetut:Ahmed", "voicetut:Sarah"]);
    expect(voices[0]!.langs).toEqual(["ar", "en"]);
    await p.close?.();
  });

  it("reports what the worker printed when it dies at start", async () => {
    const p = createLocalProvider(launch({ FAKE_WORKER_CRASH_ON_START: "1" }));
    await expect(p.synthesize("a", "namaa", "+0%", join(dir, "c.wav"))).rejects.toThrow(/voice engine stopped \(exit 3\)[\s\S]*boom: model library missing/);
  });

  it("explains a missing program", async () => {
    const w = new LocalWorker({ command: join(dir, "no-such-python"), args: [] });
    await expect(w.request({ cmd: "voices" }, 1000)).rejects.toThrow(/Cannot start the voice engine/);
  });
});

describe("storyboard voice provider", () => {
  const sb = (voice: unknown) => StoryboardSchema.safeParse({ source: "a.mp4", voice });
  it("accepts edge, local and command and defaults to edge", () => {
    expect(sb({}).data?.voice.provider).toBe("edge");
    expect(sb({ provider: "local", name: "voicetut:Sarah" }).success).toBe(true);
    expect(sb({ provider: "command", name: "piper" }).success).toBe(true);
  });
  it("rejects an unknown provider", () => {
    expect(sb({ provider: "cloud" }).success).toBe(false);
  });
});
