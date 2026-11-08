import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICES_FILE_ENV } from "../src/voice/config.js";
import { commandProvider } from "../src/voice/command.js";
import { lineDurations } from "../src/voice/index.js";

const fake = join(import.meta.dirname, "fixtures", "fake-command-tts.mjs");
let dir: string;

async function voices(commands: Record<string, unknown>) {
  const file = join(dir, "voices.json");
  await writeFile(file, JSON.stringify({ commands }));
  process.env[VOICES_FILE_ENV] = file;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-voice-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[VOICES_FILE_ENV];
});

describe("command voice", () => {
  it("fills {out} and the other placeholders in the arguments", async () => {
    await voices({ fakearg: { command: [process.execPath, fake, "{out}", "--args", "{text}", "{rate}", "{lang}"] } });
    const out = join(dir, "a.wav");
    await commandProvider.synthesize("مرحبا", "fakearg", "+10%", out);
    expect(await readFile(out, "utf8")).toBe("مرحبا|+10%|ar");
  });

  it("sends stdin text when the voice asks for it", async () => {
    await voices({ fakestdin: { command: [process.execPath, fake, "{out}", "--stdin"], stdin: "{text}" } });
    const out = join(dir, "b.wav");
    await commandProvider.synthesize("Hello there", "fakestdin", "+0%", out);
    expect(await readFile(out, "utf8")).toBe("Hello there");
  });

  it("does not pass the text through a shell", async () => {
    await voices({ fakearg: { command: [process.execPath, fake, "{out}", "--args", "{text}"] } });
    const out = join(dir, "c.wav");
    await commandProvider.synthesize("a; touch pwned && echo $HOME `id`", "fakearg", "+0%", out);
    expect(await readFile(out, "utf8")).toBe("a; touch pwned && echo $HOME `id`");
  });

  it("uses the extension of the voice and a cache key from its command", async () => {
    await voices({ mp3voice: { command: [process.execPath, fake, "{out}"], ext: "mp3" } });
    expect(commandProvider.ext?.("mp3voice")).toBe("mp3");
    expect(commandProvider.cacheKey?.("mp3voice")).toContain(fake.replaceAll("\\", "\\\\"));
  });

  it("names the voices file when the voice is not defined", async () => {
    await voices({ one: { command: ["x"] } });
    await expect(commandProvider.synthesize("hi", "two", "+0%", join(dir, "d.wav"))).rejects.toThrow(/No command voice "two".*Defined: one/s);
  });

  it("explains how to add a voice when none are defined", async () => {
    await voices({});
    await expect(commandProvider.synthesize("hi", "x", "+0%", join(dir, "e.wav"))).rejects.toThrow(/No command voices defined/);
  });

  it("fails when the program writes no audio", async () => {
    await voices({ silent: { command: [process.execPath, fake, "{out}", "--silent"] } });
    await expect(commandProvider.synthesize("hi", "silent", "+0%", join(dir, "f.wav"))).rejects.toThrow(/wrote no audio/);
  });

  it("gives up on a program that hangs", async () => {
    await voices({ hang: { command: [process.execPath, fake, "{out}", "--hang"], timeout: 0.3 } });
    await expect(commandProvider.synthesize("hi", "hang", "+0%", join(dir, "g.wav"))).rejects.toThrow(/did not finish/);
  });

  it("lists the defined voices", async () => {
    await voices({ one: { command: ["x"] }, two: { command: ["y"] } });
    expect((await commandProvider.listVoices()).map((v) => v.name)).toEqual(["one", "two"]);
  });

  it("rejects an invalid voices file with the path and the problem", async () => {
    await voices({ bad: { command: [] } });
    await expect(commandProvider.listVoices()).rejects.toThrow(/Invalid .*voices\.json[\s\S]*commands\.bad\.command/);
  });

  it("changes the cache key when a file in cacheFiles changes", async () => {
    const clip = join(dir, "clip.mp3");
    await writeFile(clip, "one");
    await voices({ clips: { command: [process.execPath, fake, "{out}"], cacheFiles: [clip] } });
    const before = commandProvider.cacheKey?.("clips");
    await writeFile(clip, "longer content");
    await utimes(clip, new Date(), new Date(Date.now() + 5000));
    expect(commandProvider.cacheKey?.("clips")).not.toBe(before);
  });

  it("keeps the cache key stable while the files are untouched", async () => {
    const clip = join(dir, "clip.mp3");
    await writeFile(clip, "one");
    await voices({ clips: { command: [process.execPath, fake, "{out}"], cacheFiles: [clip] } });
    expect(commandProvider.cacheKey?.("clips")).toBe(commandProvider.cacheKey?.("clips"));
  });

  it("marks a missing cacheFiles file as missing", async () => {
    const gone = join(dir, "gone.mp3");
    await voices({ clips: { command: [process.execPath, fake, "{out}"], cacheFiles: [gone] } });
    expect(commandProvider.cacheKey?.("clips")).toContain(`${gone}:missing`);
  });

  it("expands ~ in cacheFiles", async () => {
    await voices({ clips: { command: [process.execPath, fake, "{out}"], cacheFiles: ["~/sp-no-such-clip.mp3"] } });
    expect(commandProvider.cacheKey?.("clips")).not.toContain("~/");
  });
});

describe("lineDurations", () => {
  const lines = [{ text: "نفتح صلاحيات دور موظف تسجيل", voice: "clips", rate: "+0%" }];

  it("does not synthesize on a dry run and estimates the lengths", async () => {
    await voices({ clips: { command: [process.execPath, fake, "{out}"] } });
    const spy = vi.spyOn(commandProvider, "synthesize");
    const d = await lineDurations("command", lines, join(dir, "voice"), true);
    expect(spy).not.toHaveBeenCalled();
    expect(d[0]).toBeGreaterThan(1.7);
    expect(d[0]).toBeLessThan(1.8);
  });
});
