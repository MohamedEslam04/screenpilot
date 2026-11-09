import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { muxSubtitles, subtitleLanguageTag } from "../src/render/mux-subs.js";
import { makeSubtitles } from "../src/render/subs-cli.js";
import { checkSubtitleSync } from "../src/render/sync-check.js";
import { writeTimeline, type Timeline } from "../src/render/timeline.js";
import { makeVideo } from "./fixtures/video.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpegIt = hasFfmpeg ? it : it.skip;

const tmp = () => mkdtemp(join(tmpdir(), "sp-subs-"));
const tl = (duration: number, items: Timeline["items"]): Timeline => ({ version: 1, duration, items });
const line = (id: string, start: number, end: number, text: string, extra: Partial<Timeline["items"][number]> = {}): Timeline["items"][number] => ({ kind: "narration", id, start, end, text, ...extra });

describe("subs", () => {
  ffmpegIt("writes <video>.<code>.srt|vtt from <video>.timeline.json", async () => {
    const dir = await tmp();
    const video = makeVideo(join(dir, "demo.mp4"), 4);
    await writeTimeline(join(dir, "demo.timeline.json"), tl(4, [line("0", 1, 2, "Hello."), line("1", 2.5, 3.5, "World.")]));
    await writeFile(join(dir, "es.json"), JSON.stringify({ "0": "Hola.", "1": "Mundo." }));
    const r = await makeSubtitles(video, { languages: [{ code: "en" }, { code: "es", file: join(dir, "es.json") }], formats: ["srt", "vtt"] });
    expect(r.files.map((f) => f.slice(dir.length + 1))).toEqual(["demo.en.srt", "demo.en.vtt", "demo.es.srt", "demo.es.vtt"]);
    expect(await readFile(join(dir, "demo.es.srt"), "utf8")).toBe("1\n00:00:01,000 --> 00:00:02,000\nHola.\n\n2\n00:00:02,500 --> 00:00:03,500\nMundo.\n");
  });

  ffmpegIt("without a language writes <video>.srt", async () => {
    const dir = await tmp();
    const video = makeVideo(join(dir, "demo.mp4"), 4);
    await writeTimeline(join(dir, "demo.timeline.json"), tl(4, [line("0", 1, 2, "Hello.")]));
    const r = await makeSubtitles(video, { languages: [], formats: ["srt"] });
    expect(r.files).toEqual([join(dir, "demo.srt")]);
  });

  ffmpegIt("a stale timeline is an error that names the file", async () => {
    const dir = await tmp();
    const video = makeVideo(join(dir, "demo.mp4"), 4);
    const file = join(dir, "demo.timeline.json");
    await writeTimeline(file, tl(9, [line("0", 1, 2, "Hello.")]));
    await expect(makeSubtitles(video, { languages: [], formats: ["srt"] })).rejects.toThrow(file);
  });

  ffmpegIt("a missing timeline is an error that names the file and mentions --join", async () => {
    const dir = await tmp();
    const video = makeVideo(join(dir, "demo.mp4"), 4);
    await expect(makeSubtitles(video, { languages: [], formats: ["srt"] })).rejects.toThrow(/demo\.timeline\.json.*--join/s);
  });

  ffmpegIt("--join composes timelines with the transition arithmetic of the join, and checks the joined length", async () => {
    const dir = await tmp();
    makeVideo(join(dir, "a.mp4"), 5);
    makeVideo(join(dir, "b.mp4"), 4);
    await writeTimeline(join(dir, "a.timeline.json"), tl(5, [line("0", 1, 2, "A one")]));
    await writeTimeline(join(dir, "b.timeline.json"), tl(4, [line("0", 1, 2, "B one")]));
    // b starts at 5 - 0.6 = 4.4; the joined video is 8.4 s (made here with the same arithmetic, as a shell script would).
    const joined = makeVideo(join(dir, "all.mp4"), 8.4);
    const r = await makeSubtitles(joined, { languages: [], formats: ["srt"], join: [join(dir, "a.timeline.json"), join(dir, "b.timeline.json")], transition: 0.6 });
    expect(await readFile(join(dir, "all.srt"), "utf8")).toBe("1\n00:00:01,000 --> 00:00:02,000\nA one\n\n2\n00:00:05,400 --> 00:00:06,400\nB one\n");
    expect(r.duration).toBeCloseTo(8.4, 1);
    // A joined video of another length means the transition (or a timeline) is wrong: refuse, naming the files.
    const wrong = makeVideo(join(dir, "wrong.mp4"), 9);
    await expect(makeSubtitles(wrong, { languages: [], formats: ["srt"], join: [join(dir, "a.timeline.json"), join(dir, "b.timeline.json")], transition: 0.6 })).rejects.toThrow(/a\.timeline\.json/);
  });

  ffmpegIt("--join names the part timeline that cannot be read", async () => {
    const dir = await tmp();
    const joined = makeVideo(join(dir, "all.mp4"), 4);
    await expect(makeSubtitles(joined, { languages: [], formats: ["srt"], join: [join(dir, "nope.timeline.json")] })).rejects.toThrow(/nope\.timeline\.json/);
  });
});

describe("subtitleLanguageTag", () => {
  it("maps two-letter codes and regions to the three-letter tag mp4 wants", () => {
    expect(subtitleLanguageTag("ar")).toBe("ara");
    expect(subtitleLanguageTag("en-US")).toBe("eng");
    expect(subtitleLanguageTag("pt_BR")).toBe("por");
    expect(subtitleLanguageTag("fra")).toBe("fra");
  });
});

const probeSubs = (file: string) =>
  (
    JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_tags=language,title", "-of", "json", file]).toString()) as {
      streams: { codec_type: string; codec_name: string; tags?: { language?: string; title?: string } }[];
    }
  ).streams.filter((s) => s.codec_type === "subtitle");

describe("muxSubtitles", () => {
  ffmpegIt("adds soft tracks with language metadata to <video>.subs.mp4 (mov_text) and leaves the original alone", async () => {
    const dir = await tmp();
    const video = makeVideo(join(dir, "demo.mp4"), 4, { audio: true });
    await writeTimeline(join(dir, "demo.timeline.json"), tl(4, [line("0", 1, 2, "Hello.")]));
    await writeFile(join(dir, "ar.json"), JSON.stringify({ "0": "مرحبا." }));
    const before = await readFile(video);
    const subs = await makeSubtitles(video, { languages: [{ code: "en" }, { code: "ar", file: join(dir, "ar.json") }], formats: ["srt", "vtt"] });
    const out = await muxSubtitles(video, subs.tracks);
    expect(out).toBe(join(dir, "demo.subs.mp4"));
    const tracks = probeSubs(out);
    expect(tracks.map((t) => [t.codec_name, t.tags?.language])).toEqual([["mov_text", "eng"], ["mov_text", "ara"]]);
    expect((await readFile(video)).equals(before)).toBe(true);
    expect((await stat(out)).size).toBeGreaterThan(0);
  });

  ffmpegIt("uses webvtt for a .mkv", async () => {
    const dir = await tmp();
    const mp4 = makeVideo(join(dir, "src.mp4"), 3, { audio: true });
    const mkv = join(dir, "demo.mkv");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-c", "copy", mkv]);
    await writeTimeline(join(dir, "demo.timeline.json"), tl(3, [line("0", 1, 2, "Hello.")]));
    const subs = await makeSubtitles(mkv, { languages: [{ code: "en" }], formats: ["srt", "vtt"] });
    const out = await muxSubtitles(mkv, subs.tracks);
    expect(out).toBe(join(dir, "demo.subs.mkv"));
    expect(probeSubs(out).map((t) => [t.codec_name, t.tags?.language])).toEqual([["webvtt", "eng"]]);
  });

  it("refuses nothing to mux", async () => {
    await expect(muxSubtitles("/x/demo.mp4", [])).rejects.toThrow(/no subtitle/i);
  });
});

/** Silent 0-1.5 s and 3-4 s, a tone 1.5-3 s and 4-6 s. */
async function toneVideo(dir: string): Promise<string> {
  const file = join(dir, "tone.mp4");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=160x90:d=6:r=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6,volume=enable='between(t,0,1.5)+between(t,3,4)':volume=0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
  return file;
}

describe("checkSubtitleSync", () => {
  ffmpegIt("warns when the first sound after a cue start is more than 0.4 s away, and not otherwise", async () => {
    const dir = await tmp();
    const video = await toneVideo(dir);
    const r = await checkSubtitleSync(video, tl(6, [line("a", 1.5, 2.5, "on time"), line("b", 3, 3.8, "late sound"), line("c", 4.2, 5, "inside sound"), line("d", 1, 1.4, "half a second early")]));
    expect(r.checked).toBe(4);
    const text = r.warnings.join("\n");
    expect(text).toContain("late sound");
    expect(text).toContain("half a second early");
    expect(text).not.toContain("on time");
    expect(text).not.toContain("inside sound");
    const b = r.offsets.find((o) => o.text === "late sound")!;
    expect(b.offset).toBeCloseTo(1, 0);
  });

  ffmpegIt("checks nothing for a video without sound", async () => {
    const dir = await tmp();
    const video = makeVideo(join(dir, "mute.mp4"), 3);
    const r = await checkSubtitleSync(video, tl(3, [line("a", 1, 2, "x")]));
    expect(r.checked).toBe(0);
    expect(r.warnings).toEqual([]);
  });
});
