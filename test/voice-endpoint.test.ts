import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VOICES_FILE_ENV } from "../src/voice/config.js";
import { baseUrlFor, clearEndpoint, normalizeBaseUrl, resolveEndpoint, setEndpoint } from "../src/voice/endpoint.js";

const ENV = ["ELEVENLABS_BASE_URL", "GEMINI_BASE_URL", VOICES_FILE_ENV];
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(async () => {
  for (const n of ENV) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  dir = await mkdtemp(join(tmpdir(), "sp-endpoint-"));
  process.env[VOICES_FILE_ENV] = join(dir, "voices.json");
});
afterEach(() => {
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and a pasted API version", () => {
    expect(normalizeBaseUrl("elevenlabs", "https://api.eu.residency.elevenlabs.io/")).toBe("https://api.eu.residency.elevenlabs.io");
    expect(normalizeBaseUrl("elevenlabs", "https://api.eu.residency.elevenlabs.io/v1/")).toBe("https://api.eu.residency.elevenlabs.io");
    expect(normalizeBaseUrl("elevenlabs", "  https://gw.example.com/eleven/v1  ")).toBe("https://gw.example.com/eleven");
    expect(normalizeBaseUrl("gemini", "https://gw.example.com/g/v1beta/models")).toBe("https://gw.example.com/g");
    expect(normalizeBaseUrl("gemini", "https://generativelanguage.googleapis.com/v1beta")).toBe("https://generativelanguage.googleapis.com");
  });

  it("drops a query string or fragment", () => {
    expect(normalizeBaseUrl("elevenlabs", "https://gw.example.com/x?a=1#f")).toBe("https://gw.example.com/x");
  });

  it("knows the ElevenLabs region names", () => {
    expect(normalizeBaseUrl("elevenlabs", "eu")).toBe("https://api.eu.residency.elevenlabs.io");
    expect(normalizeBaseUrl("elevenlabs", "IN")).toBe("https://api.in.residency.elevenlabs.io");
    expect(normalizeBaseUrl("elevenlabs", "sg")).toBe("https://api.sg.residency.elevenlabs.io");
    expect(normalizeBaseUrl("elevenlabs", "us")).toBe("https://api.us.elevenlabs.io");
    expect(() => normalizeBaseUrl("gemini", "eu")).toThrow(/not a web address/);
  });

  it("needs https, except for this machine", () => {
    expect(() => normalizeBaseUrl("elevenlabs", "http://gw.example.com")).toThrow(/https/);
    expect(normalizeBaseUrl("elevenlabs", "http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeBaseUrl("elevenlabs", "http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
  });

  it("refuses a login in the address and anything that is not an address", () => {
    expect(() => normalizeBaseUrl("elevenlabs", "https://user:pw@gw.example.com")).toThrow(/user name or password/);
    expect(() => normalizeBaseUrl("elevenlabs", "not a url")).toThrow(/not a web address/);
    expect(() => normalizeBaseUrl("elevenlabs", "")).toThrow(/empty/);
    expect(() => normalizeBaseUrl("elevenlabs", "ftp://x.example.com")).toThrow(/https/);
  });
});

describe("resolveEndpoint", () => {
  it("is the default host with nothing set", () => {
    expect(resolveEndpoint("elevenlabs")).toEqual({ url: "https://api.elevenlabs.io", source: "default", isDefault: true });
    expect(baseUrlFor("gemini")).toBe("https://generativelanguage.googleapis.com");
  });

  it("reads voices.json", async () => {
    await writeFile(process.env[VOICES_FILE_ENV]!, JSON.stringify({ providers: { elevenlabs: { baseUrl: "eu" } } }));
    expect(resolveEndpoint("elevenlabs")).toEqual({ url: "https://api.eu.residency.elevenlabs.io", source: "file", isDefault: false });
    expect(resolveEndpoint("gemini").source).toBe("default");
  });

  it("lets the environment win over the file", async () => {
    await writeFile(process.env[VOICES_FILE_ENV]!, JSON.stringify({ providers: { elevenlabs: { baseUrl: "eu" } } }));
    process.env.ELEVENLABS_BASE_URL = "https://api.in.residency.elevenlabs.io/v1";
    expect(resolveEndpoint("elevenlabs")).toEqual({ url: "https://api.in.residency.elevenlabs.io", source: "env", isDefault: false });
  });

  it("names the source of a bad value", async () => {
    process.env.GEMINI_BASE_URL = "http://evil.example.com";
    expect(() => resolveEndpoint("gemini")).toThrow(/GEMINI_BASE_URL/);
    delete process.env.GEMINI_BASE_URL;
    await writeFile(process.env[VOICES_FILE_ENV]!, JSON.stringify({ providers: { gemini: { baseUrl: "http://evil.example.com" } } }));
    expect(() => resolveEndpoint("gemini")).toThrow(/voices\.json/);
  });

  it("treats a value equal to the default host as the default (cache stays valid)", () => {
    process.env.ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/";
    expect(resolveEndpoint("elevenlabs")).toMatchObject({ url: "https://api.elevenlabs.io", source: "env", isDefault: true });
  });

  it("ignores an empty environment variable", () => {
    process.env.ELEVENLABS_BASE_URL = "";
    expect(resolveEndpoint("elevenlabs").source).toBe("default");
  });
});

describe("setEndpoint / clearEndpoint", () => {
  const read = async () => JSON.parse(await readFile(process.env[VOICES_FILE_ENV]!, "utf8"));

  it("stores the clean address, keeps what else is in voices.json, and resolves it", async () => {
    await writeFile(process.env[VOICES_FILE_ENV]!, JSON.stringify({ local: { python: "/x/python" }, providers: { gemini: { baseUrl: "https://gw.example.com" } } }));
    const r = await setEndpoint("elevenlabs", "EU");
    expect(r.url).toBe("https://api.eu.residency.elevenlabs.io");
    expect(await read()).toEqual({
      local: { python: "/x/python" },
      providers: { gemini: { baseUrl: "https://gw.example.com" }, elevenlabs: { baseUrl: "https://api.eu.residency.elevenlabs.io" } },
    });
    expect(resolveEndpoint("elevenlabs").source).toBe("file");
  });

  it("creates the file when there is none, and refuses a bad address without writing", async () => {
    await expect(setEndpoint("elevenlabs", "http://evil.example.com")).rejects.toThrow(/https/);
    await expect(readFile(process.env[VOICES_FILE_ENV]!)).rejects.toThrow();
    await setEndpoint("gemini", "https://gw.example.com/v1beta/");
    expect((await read()).providers.gemini.baseUrl).toBe("https://gw.example.com");
  });

  it("clears one provider and leaves the rest", async () => {
    await setEndpoint("elevenlabs", "eu");
    await setEndpoint("gemini", "https://gw.example.com");
    expect(await clearEndpoint("elevenlabs")).toBe(true);
    expect(await read()).toEqual({ providers: { gemini: { baseUrl: "https://gw.example.com" } } });
    expect(await clearEndpoint("elevenlabs")).toBe(false);
    expect(resolveEndpoint("elevenlabs").source).toBe("default");
  });
});
