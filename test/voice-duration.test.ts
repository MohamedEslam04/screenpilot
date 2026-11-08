import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clipDuration, estimateLineSeconds } from "../src/voice/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sp-dur-"));
});

describe("clipDuration", () => {
  it("trusts the sidecar and does not probe the audio", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "not audio, a probe would fail");
    await writeFile(`${file}.dur`, "1.5");
    expect(await clipDuration(file)).toBe(1.5);
  });

  it("probes once and writes the sidecar", async () => {
    const file = join(dir, "b.wav");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.5", file]);
    const d = await clipDuration(file);
    expect(d).toBeGreaterThan(0.4);
    expect(d).toBeLessThan(0.6);
    expect(existsSync(`${file}.dur`)).toBe(true);
    expect(Number(await readFile(`${file}.dur`, "utf8"))).toBeCloseTo(d, 5);
  });

  it("ignores a broken sidecar and probes again", async () => {
    const file = join(dir, "c.wav");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.5", file]);
    await writeFile(`${file}.dur`, "garbage");
    const d = await clipDuration(file);
    expect(d).toBeGreaterThan(0.4);
  });
});

describe("estimateLineSeconds", () => {
  it("counts non-space letters at 13 per second", () => {
    const s = estimateLineSeconds("نفتح صلاحيات دور موظف تسجيل");
    expect(s).toBeGreaterThan(1.7);
    expect(s).toBeLessThan(1.8);
  });

  it("never goes under 1.2 seconds", () => {
    expect(estimateLineSeconds("Hi")).toBe(1.2);
    expect(estimateLineSeconds("")).toBe(1.2);
  });
});
