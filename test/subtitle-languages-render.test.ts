import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderStoryboard } from "../src/render/index.js";
import { parseSubtitleLanguages } from "../src/render/subtitle-langs.js";
import { renderSequence } from "../src/sequence/index.js";
import { makeVideo } from "./fixtures/video.js";

// HyperFrames (a headless Chrome render) is faked: it writes a 1 s video to the file passed with -o. ffmpeg and ffprobe are real.
vi.mock("../src/util/exec.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/util/exec.js")>();
  return {
    ...real,
    run: async (cmd: string, args: string[], opts?: Parameters<typeof real.run>[2]) => {
      if (cmd !== process.execPath) return real.run(cmd, args, opts);
      return real.run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=1:r=10", "-pix_fmt", "yuv420p", args[args.indexOf("-o") + 1]!]);
    },
  };
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpegIt = hasFfmpeg ? it : it.skip;

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

/** Two storyboards in folders `a` and `b`, each with ready-made narration audio (no voice is synthesized). */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sp-seq-timeline-"));
  await mkdir(join(dir, "a"), { recursive: true });
  await mkdir(join(dir, "b"), { recursive: true });
  makeVideo(join(dir, "a/rec.mp4"), 3);
  makeVideo(join(dir, "b/rec.mp4"), 2);
  for (const f of ["a/one.wav", "b/one.wav"]) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8", join(dir, f)]);
  }
  await writeJson(join(dir, "a/demo.json"), {
    source: "rec.mp4",
    intro: { title: "A", dur: 1 },
    narration: [
      { at: 0.5, text: "A one", audio: "one.wav" },
      { at: 1.8, text: "A two", audio: "one.wav", id: "closing" },
    ],
  });
  await writeJson(join(dir, "b/other.json"), { source: "rec.mp4", narration: [{ at: 0.2, text: "B one", audio: "one.wav" }] });
  await writeJson(join(dir, "seq.json"), {
    parts: [{ storyboard: "a/demo.json" }, { storyboard: "b/other.json", transition: { type: "crossfade", dur: 0.5 } }],
  });
  return dir;
}

describe("subtitle files per language", () => {
  ffmpegIt("render writes <output>.<code>.srt|vtt from the translation and the video's own lines, and no plain file", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "es.json"), { "0": "Uno", closing: "Dos" });
    const r = await renderStoryboard(join(dir, "a/demo.json"), {
      output: join(dir, "out/demo.mp4"),
      quality: "draft",
      history: false,
      subtitles: ["srt"],
      subtitleLanguages: parseSubtitleLanguages(`en,es=${join(dir, "es.json")}`),
    });
    expect(r.files.map((f) => f.slice(dir.length + 1))).toEqual(["out/demo.en.srt", "out/demo.es.srt"]);
    expect(existsSync(join(dir, "out/demo.srt"))).toBe(false);
    expect(await readFile(join(dir, "out/demo.es.srt"), "utf8")).toBe("1\n00:00:01,500 --> 00:00:02,300\nUno\n\n2\n00:00:02,800 --> 00:00:03,600\nDos\n");
    expect(await readFile(join(dir, "out/demo.en.srt"), "utf8")).toContain("A one");
  }, 60_000);

  ffmpegIt("render --subtitles alone still writes the plain file with the old cues", async () => {
    const dir = await fixture();
    const r = await renderStoryboard(join(dir, "a/demo.json"), { output: join(dir, "out/demo.mp4"), quality: "draft", history: false, subtitles: ["srt", "vtt"] });
    expect(r.files.map((f) => f.slice(dir.length + 1))).toEqual(["out/demo.srt", "out/demo.vtt"]);
    expect(await readFile(join(dir, "out/demo.srt"), "utf8")).toBe("1\n00:00:01,500 --> 00:00:02,300\nA one\n\n2\n00:00:02,800 --> 00:00:03,600\nA two\n");
  }, 60_000);

  ffmpegIt("a missing translation file fails before anything is rendered", async () => {
    const dir = await fixture();
    await expect(
      renderStoryboard(join(dir, "a/demo.json"), { output: join(dir, "out/demo.mp4"), quality: "draft", history: false, subtitleLanguages: parseSubtitleLanguages(`es=${join(dir, "nope.json")}`) }),
    ).rejects.toThrow(/nope\.json/);
    expect(existsSync(join(dir, "out/demo.mp4"))).toBe(false);
  }, 60_000);

  ffmpegIt("sequence writes the joined files per language, by chapter, with the offsets of the join", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "es.json"), { a: ["Uno", "Dos"], b: ["Tres"] });
    const r = await renderSequence(join(dir, "seq.json"), {
      quality: "draft",
      subtitleLanguages: parseSubtitleLanguages(`en,es=${join(dir, "es.json")}`),
      subtitles: ["srt"],
    });
    expect(r.files!.map((f) => f.slice(dir.length + 1))).toEqual(["seq.en.srt", "seq.es.srt"]);
    const es = await readFile(join(dir, "seq.es.srt"), "utf8");
    // The crossfade puts part b first in time (0.7 s) ahead of part a's lines (1.5 s, 2.8 s), see sequence-timeline.test.
    expect(es.match(/\n(Uno|Dos|Tres)\n/g)!.map((s) => s.trim())).toEqual(["Tres", "Uno", "Dos"]);
    expect(es).toMatch(/^1\n00:00:00,700 --> /);
  }, 60_000);

  ffmpegIt("a chapter with the wrong number of lines fails with the chapter and both counts", async () => {
    const dir = await fixture();
    await writeJson(join(dir, "es.json"), { a: ["Uno"], b: ["Tres"] });
    await renderSequence(join(dir, "seq.json"), { quality: "draft" });
    await expect(renderSequence(join(dir, "seq.json"), { quality: "draft", subtitleLanguages: parseSubtitleLanguages(`es=${join(dir, "es.json")}`) })).rejects.toThrow(/chapter "a" has 1 line but the video has 2/);
  }, 120_000);

  ffmpegIt("sequence without languages and with subtitles writes the plain <output>.srt", async () => {
    const dir = await fixture();
    const r = await renderSequence(join(dir, "seq.json"), { quality: "draft", subtitles: ["vtt"] });
    expect(r.files!.map((f) => f.slice(dir.length + 1))).toEqual(["seq.vtt"]);
  }, 60_000);
});
