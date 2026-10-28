import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appHome } from "../src/setup/index.js";
import { voiceHome, voiceSetup } from "../src/setup/voice.js";

const realPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = realPath;
});

describe("voiceHome", () => {
  it("is next to the app folder, not inside it (setup wipes the app folder on update)", () => {
    expect(voiceHome().startsWith(`${appHome()}-`)).toBe(true);
    expect(voiceHome().startsWith(`${appHome()}/`)).toBe(false);
  });
  it("takes a folder of the user's choice", () => {
    expect(voiceHome("/data/voices")).toBe(resolve("/data/voices"));
  });
});

describe("voiceSetup", () => {
  it("rejects an unknown model", async () => {
    await expect(voiceSetup({ model: "piper" as never, dir: await mkdtemp(join(tmpdir(), "sp-vs-")) })).rejects.toThrow(/Unknown model "piper"/);
  });

  it("explains how to get uv when it is missing", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "sp-nopath-"));
    await expect(voiceSetup({ model: "voicetut", dir: await mkdtemp(join(tmpdir(), "sp-vs-")), yes: true })).rejects.toThrow(/needs "uv".*docs\.astral\.sh/s);
  });
});
