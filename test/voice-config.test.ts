import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadVoiceConfig, resetVoiceConfigWarnings, VOICES_FILE_ENV } from "../src/voice/config.js";

let file: string;
let saved: string | undefined;
let stderr: ReturnType<typeof vi.spyOn>;

const write = (data: unknown) => writeFile(file, JSON.stringify(data));
const warnings = () => stderr.mock.calls.map((c) => String(c[0])).join("");

beforeEach(async () => {
  saved = process.env[VOICES_FILE_ENV];
  file = join(await mkdtemp(join(tmpdir(), "sp-vconf-")), "voices.json");
  process.env[VOICES_FILE_ENV] = file;
  resetVoiceConfigWarnings();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderr.mockRestore();
  if (saved === undefined) delete process.env[VOICES_FILE_ENV];
  else process.env[VOICES_FILE_ENV] = saved;
});

describe("voices.json written by a newer version", () => {
  it("ignores an unknown top-level key, keeps the rest and says so once", async () => {
    await write({ commands: { one: { command: ["x"] } }, providers: { elevenlabs: { baseUrl: "eu" } }, future: 1 });
    const cfg = loadVoiceConfig();
    expect(Object.keys(cfg.commands)).toEqual(["one"]);
    expect(warnings()).toMatch(/voices\.json/);
    expect(warnings()).toMatch(/"future"/);
    expect(warnings()).toMatch(/newer version|update/i);
    loadVoiceConfig();
    expect(stderr.mock.calls.filter((c) => /future/.test(String(c[0])))).toHaveLength(1);
  });

  it("ignores an unknown key inside a command voice and names its path", async () => {
    await write({ commands: { one: { command: ["x"], retries: 3 } } });
    expect(loadVoiceConfig().commands.one!.command).toEqual(["x"]);
    expect(warnings()).toMatch(/commands\.one\.retries/);
  });

  it("still fails on a real mistake, even next to an unknown key", async () => {
    await write({ future: 1, commands: { bad: { command: [] } } });
    expect(() => loadVoiceConfig()).toThrow(/Invalid .*voices\.json[\s\S]*commands\.bad\.command/);
  });

  it("says nothing for a file that is fully known", async () => {
    await write({ commands: { one: { command: ["x"] } }, providers: { gemini: { baseUrl: "https://gw.example.com" } } });
    loadVoiceConfig();
    expect(warnings()).toBe("");
  });
});
