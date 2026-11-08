import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concatList, joinAudioFilter, joinChunks } from "../src/render/join.js";
import { makeVideo } from "./fixtures/video.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("joinAudioFilter", () => {
  it("trims or pads each chunk's audio to its video length and joins them, as the spike measured", () => {
    expect(
      joinAudioFilter([
        { duration: 180, hasAudio: true },
        { duration: 20.4, hasAudio: true },
      ]),
    ).toBe(
      "[0:a]aresample=48000:async=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=180.000,asetpts=PTS-STARTPTS[a0];\n" +
        "[1:a]aresample=48000:async=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=20.400,asetpts=PTS-STARTPTS[a1];\n" +
        "[a0][a1]concat=n=2:v=0:a=1[aout]",
    );
  });

  it("puts silence of the chunk's length where a chunk has no audio", () => {
    const f = joinAudioFilter([
      { duration: 5, hasAudio: false },
      { duration: 6, hasAudio: true },
    ]);
    expect(f).toContain("anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=5.000,asetpts=PTS-STARTPTS[a0]");
    expect(f).toContain("[1:a]aresample");
  });
});

describe("concatList", () => {
  it("quotes paths for the concat demuxer", () => {
    expect(concatList(["/a/b.mp4", "/it's/c.mp4"])).toBe("file '/a/b.mp4'\nfile '/it'\\''s/c.mp4'\n");
  });
});

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration,duration_ts,sample_rate", "-of", "json", file], {
    encoding: "utf8",
  });
  type S = { codec_type: string; nb_read_frames?: string; duration?: string; duration_ts?: number; sample_rate?: string };
  const streams = (JSON.parse(out) as { streams: S[] }).streams;
  const v = streams.find((s) => s.codec_type === "video")!;
  const a = streams.find((s) => s.codec_type === "audio");
  // The container's audio length: the edit list trims the AAC priming and end padding (what players play).
  return { frames: Number(v.nb_read_frames), duration: Number(v.duration), audio: !!a, audioSamples: a ? Number(a.duration_ts) : 0, sampleRate: Number(a?.sample_rate ?? 0) };
}

/** Decoded audio samples per channel at 48 kHz. ffmpeg's decoder keeps the AAC end padding (under 1024 samples) even for a one-piece file. */
const decoded = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 }).length / 4;

describe.skipIf(!hasFfmpeg)("joinChunks (real ffmpeg)", () => {
  it("copies the video and encodes the audio once, keeping both the same length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-join-"));
    const a = makeVideo(join(dir, "a.mp4"), 2, { audio: true, size: "64x36", fps: 10 });
    const b = makeVideo(join(dir, "b.mp4"), 3, { audio: true, size: "64x36", fps: 10 });
    const out = join(dir, "joined.mp4");
    await joinChunks([a, b], out, { workDir: dir });

    const pa = probe(a);
    const pb = probe(b);
    const po = probe(out);
    expect(po.frames).toBe(pa.frames + pb.frames);
    expect(po.audio).toBe(true);
    expect(po.sampleRate).toBe(48000);
    expect(Math.abs(po.audioSamples / 48000 - po.duration)).toBeLessThanOrEqual(0.001);
    // Each chunk keeps its AAC priming and padding; none of it may pile up at the joins.
    const sum = Math.round((pa.duration + pb.duration) * 48000);
    expect(po.audioSamples).toBeLessThanOrEqual(sum);
    // Decoded, only the one end padding of the single final encode is left (a copy join adds 1536 per chunk).
    expect(decoded(out)).toBeLessThan(sum + 1024);
  });

  it("joins chunks without audio into a video without audio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-join-"));
    const a = makeVideo(join(dir, "a.mp4"), 1, { size: "64x36", fps: 10 });
    const b = makeVideo(join(dir, "b.mp4"), 1, { size: "64x36", fps: 10 });
    const out = join(dir, "joined.mp4");
    await joinChunks([a, b], out, { workDir: dir });
    const po = probe(out);
    expect(po.frames).toBe(20);
    expect(po.audio).toBe(false);
  });
});
