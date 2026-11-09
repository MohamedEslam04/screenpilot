import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSecret, getSecret, secretsFile, setSecret } from "../src/voice/secrets.js";

let dir: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, eleven: process.env.ELEVENLABS_API_KEY, gemini: process.env.GEMINI_API_KEY };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-secrets-"));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
  restore("XDG_CONFIG_HOME", saved.xdg);
  restore("ELEVENLABS_API_KEY", saved.eleven);
  restore("GEMINI_API_KEY", saved.gemini);
});

describe("voice secrets", () => {
  it("lives in secrets.json under the config folder", () => {
    expect(secretsFile()).toBe(join(dir, "screenpilot", "secrets.json"));
  });

  it("prefers the environment over the file", () => {
    setSecret("GEMINI_API_KEY", "from-file");
    process.env.GEMINI_API_KEY = "from-env";
    expect(getSecret("GEMINI_API_KEY")).toBe("from-env");
  });

  it("falls back to the file, and an empty env var does not count", () => {
    setSecret("GEMINI_API_KEY", "from-file");
    process.env.GEMINI_API_KEY = "";
    expect(getSecret("GEMINI_API_KEY")).toBe("from-file");
  });

  it("writes the file with mode 0600 and keeps the other keys", async () => {
    setSecret("ELEVENLABS_API_KEY", "one");
    setSecret("GEMINI_API_KEY", "two");
    expect(JSON.parse(await readFile(secretsFile(), "utf8"))).toEqual({ ELEVENLABS_API_KEY: "one", GEMINI_API_KEY: "two" });
    if (process.platform !== "win32") expect((await stat(secretsFile())).mode & 0o777).toBe(0o600);
  });

  it("replaces a key that is already stored", () => {
    setSecret("GEMINI_API_KEY", "old");
    setSecret("GEMINI_API_KEY", "new");
    expect(getSecret("GEMINI_API_KEY")).toBe("new");
  });

  it("names the env var and the file, never a key value, when the key is missing", () => {
    setSecret("ELEVENLABS_API_KEY", "super-secret-value");
    let message = "";
    try {
      getSecret("GEMINI_API_KEY");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).toContain(secretsFile());
    expect(message).not.toContain("super-secret-value");
  });

  it("findSecret returns undefined instead of throwing", () => {
    expect(findSecret("GEMINI_API_KEY")).toBeUndefined();
  });

  it("treats a broken secrets file as empty", () => {
    mkdirSync(join(dir, "screenpilot"), { recursive: true });
    writeFileSync(secretsFile(), "{not json");
    expect(findSecret("GEMINI_API_KEY")).toBeUndefined();
  });
});
