import { describe, expect, it } from "vitest";
import { buildCutFilter } from "../src/render/cut.js";
import { buildLoudnormArgs, buildMeasureArgs, parseLoudnorm } from "../src/render/loudness.js";
import { buildMusicFilter, planMusicRange } from "../src/render/music.js";
import { buildPlan, type PlanInput } from "../src/render/plan.js";
import { AudioSchema, DuckSchema, INHERITED_KEYS, MusicSchema, StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

function sbOf(extra: Record<string, unknown>) {
  return StoryboardSchema.parse({ source: "r.mp4", ...extra });
}

describe("music and audio in the schema", () => {
  it("keeps the old shape when no new field is set", () => {
    expect(MusicSchema.parse({ src: "a.mp3" })).toEqual({ src: "a.mp3", volume: 0.12 });
    expect(DuckSchema.parse({})).toEqual({ amount: 0.6, attack: 0.2, release: 0.5 });
  });

  it("takes fades, loop, offset and a source-time range", () => {
    const m = MusicSchema.parse({ src: "a.mp3", fadeIn: 0, fadeOut: 4, loop: true, offset: 12, from: 3, to: 30 });
    expect(m).toMatchObject({ fadeIn: 0, fadeOut: 4, loop: true, offset: 12, from: 3, to: 30 });
    expect(MusicSchema.safeParse({ src: "a.mp3", offset: -1 }).success).toBe(false);
    expect(MusicSchema.safeParse({ src: "a.mp3", fadeIn: 31 }).success).toBe(false);
  });

  it("lets the music duck under overlays too", () => {
    expect(DuckSchema.parse({ under: ["narration", "overlays"] }).under).toEqual(["narration", "overlays"]);
    expect(DuckSchema.safeParse({ under: [] }).success).toBe(false);
    expect(DuckSchema.safeParse({ under: ["source"] }).success).toBe(false);
  });

  it("fills loudness defaults and is inherited by extends", () => {
    expect(AudioSchema.parse({ loudness: {} })).toEqual({ loudness: { target: -16, truePeak: -1.5 } });
    expect(AudioSchema.parse({ denoise: true })).toEqual({ denoise: true });
    expect(AudioSchema.safeParse({ loudness: { target: 3 } }).success).toBe(false);
    expect(AudioSchema.safeParse({ loudness: { truePeak: 2 } }).success).toBe(false);
    expect(INHERITED_KEYS).toContain("audio");
    expect(sbOf({}).audio).toBeUndefined();
  });
});

describe("planMusicRange", () => {
  const tl = (segments: { in: number; out: number }[] = []) => buildTimeline({ segments: segments.map((s) => ({ ...s, speed: 1 })), holds: [], sourceDuration: 20, offset: 0 });

  it("is not custom without loop, offset, from or to", () => {
    const r = planMusicRange(sbOf({ music: { src: "a.mp3" } }).music!, tl(), 20);
    expect(r).toMatchObject({ custom: false, start: 0, end: 20, warnings: [] });
  });

  it("is custom for loop, offset, from and to", () => {
    for (const extra of [{ loop: true }, { offset: 3 }, { from: 2 }, { to: 9 }]) {
      expect(planMusicRange(sbOf({ music: { src: "a.mp3", ...extra } }).music!, tl(), 20).custom).toBe(true);
    }
  });

  it("maps from and to (source seconds) through the cuts", () => {
    const r = planMusicRange(sbOf({ music: { src: "a.mp3", from: 7, to: 12 } }).music!, tl([{ in: 5, out: 15 }]), 10);
    expect(r).toMatchObject({ start: 2, end: 7, warnings: [] });
  });

  it("warns and falls back when a bound is in a cut region or the range is empty", () => {
    const cut = planMusicRange(sbOf({ music: { src: "a.mp3", from: 2 } }).music!, tl([{ in: 5, out: 15 }]), 10);
    expect(cut.start).toBe(0);
    expect(cut.warnings[0]).toContain("music.from");
    const empty = planMusicRange(sbOf({ music: { src: "a.mp3", from: 9, to: 8 } }).music!, tl(), 20);
    expect(empty).toMatchObject({ start: 0, end: 20 });
    expect(empty.warnings[0]).toContain("music");
  });
});

describe("buildMusicFilter", () => {
  it("starts at the offset, fades in and out, and stops at the length", () => {
    const f = buildMusicFilter({ offset: 4, loop: false, length: 10, fadeIn: 1, fadeOut: 2, trackDuration: 120 });
    expect(f.length).toBe(10);
    expect(f.filter).toContain("atrim=start=4");
    expect(f.filter).toContain("atrim=end=10");
    expect(f.filter).toContain("afade=t=in:st=0:d=1");
    expect(f.filter).toContain("afade=t=out:st=8:d=2");
    expect(f.filter).not.toContain("aloop");
    expect(f.filter).toMatch(/aformat=sample_rates=48000:channel_layouts=stereo\[out\]$/);
  });

  it("repeats a short track when looping and fills the whole length", () => {
    const f = buildMusicFilter({ offset: 0, loop: true, length: 30, fadeIn: 1, fadeOut: 2, trackDuration: 8 });
    expect(f.length).toBe(30);
    expect(f.filter).toContain("aloop=loop=-1:size=2147483647");
  });

  it("ends with the track, fading out at its real end, when not looping", () => {
    const f = buildMusicFilter({ offset: 2, loop: false, length: 30, fadeIn: 1, fadeOut: 2, trackDuration: 8 });
    expect(f.length).toBe(6);
    expect(f.filter).toContain("afade=t=out:st=4:d=2");
  });

  it("clamps fades to half the length and skips zero fades", () => {
    const f = buildMusicFilter({ offset: 0, loop: false, length: 2, fadeIn: 5, fadeOut: 5, trackDuration: 60 });
    expect(f.filter).toContain("afade=t=in:st=0:d=1");
    expect(f.filter).toContain("afade=t=out:st=1:d=1");
    const none = buildMusicFilter({ offset: 0, loop: false, length: 10, fadeIn: 0, fadeOut: 0, trackDuration: 60 });
    expect(none.filter).not.toContain("afade");
  });

  it("has no length when the offset is past the end of the track", () => {
    expect(buildMusicFilter({ offset: 9, loop: false, length: 10, fadeIn: 1, fadeOut: 2, trackDuration: 8 }).length).toBe(0);
  });
});

function planOf(sbExtra: Record<string, unknown>, input: Partial<PlanInput> = {}) {
  const sb = sbOf(sbExtra);
  const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 20, offset: 0 });
  return buildPlan({ sb, timeline, editedSrc: "e.mp4", editedHasAudio: false, source: { width: 1920, height: 1080 }, narration: [], clicks: [], ...input });
}

describe("music in the plan", () => {
  it("keeps today's item (fades 1 and 2 baked into attributes) when nothing new is used", () => {
    const p = planOf({ music: { src: "a.mp3", volume: 0.2 } }, { musicSrc: "music.mp3" });
    expect(p.audio).toEqual([{ src: "music.mp3", start: 0, duration: 20, volume: 0.2, fadeIn: 1, fadeOut: 2 }]);
  });

  it("takes fadeIn and fadeOut from the storyboard on the old path", () => {
    const p = planOf({ music: { src: "a.mp3", fadeIn: 0, fadeOut: 5 } }, { musicSrc: "music.mp3" });
    expect(p.audio[0]).toMatchObject({ fadeIn: 0, fadeOut: 5 });
  });

  it("uses the prepared clip (fades already baked in) for a custom range", () => {
    const p = planOf({ music: { src: "a.mp3", loop: true, from: 5 } }, { musicSrc: "music-track.wav", musicClip: { start: 5, duration: 15 } });
    expect(p.audio).toEqual([{ src: "music-track.wav", start: 5, duration: 15, volume: 0.12 }]);
  });

  const video = { src: "overlays/0.mp4", kind: "video" as const, duration: 4, hasAudio: true };
  const overlay = { src: "v.mp4", at: 5, dur: 4, x: 0.7, y: 0.6, w: 0.25, h: 0.3, mute: false };

  it("does not duck for overlay sound unless asked", () => {
    const p = planOf({ music: { src: "a.mp3", duck: {} }, overlays: [overlay] }, { musicSrc: "music.mp3", overlays: [video] });
    expect(p.audio.find((a) => a.src === "music.mp3")!.duck).toBeUndefined();
  });

  it("ducks the music under an overlay's sound when duck.under has overlays", () => {
    const p = planOf({ music: { src: "a.mp3", volume: 0.2, duck: { under: ["overlays"] } }, overlays: [overlay] }, { musicSrc: "music.mp3", overlays: [video] });
    const music = p.audio.find((a) => a.src === "music.mp3")!;
    expect(music.duck![0]).toMatchObject({ t: 4.8, dur: 0.2, from: 0.2, to: 0.08 });
    expect(music.duck![1]).toMatchObject({ t: 9, to: 0.2 });
    // The order of the audio items is unchanged: music first, then the overlay's sound.
    expect(p.audio.map((a) => a.src)).toEqual(["music.mp3", "overlays/0.mp4"]);
  });

  it("ducks under narration and overlays together", () => {
    const p = planOf(
      { music: { src: "a.mp3", volume: 0.2, duck: { under: ["narration", "overlays"] } }, overlays: [overlay] },
      { musicSrc: "music.mp3", overlays: [video], narration: [{ at: 1, text: "hi", duration: 2, file: "x", caption: false, src: "voice/1.mp3" }] },
    );
    const music = p.audio.find((a) => a.src === "music.mp3")!;
    expect(music.duck!.map((d) => d.t)).toEqual([0.8, 3, 4.8, 9]);
  });
});

describe("denoising the source audio", () => {
  const pieces = [{ kind: "play" as const, in: 0, out: 5, speed: 1, volume: 1, outStart: 0, outEnd: 5 }];
  const base = { pieces, fps: 30, sourceDuration: 10, keepAudio: true };

  it("adds afftdn to every piece's audio chain only when asked", () => {
    expect(buildCutFilter({ ...base, denoise: true })).toContain("afftdn=nr=18:nf=-30:tn=1");
    expect(buildCutFilter(base)).not.toContain("afftdn");
    expect(buildCutFilter({ ...base, keepAudio: false, denoise: true })).not.toContain("afftdn");
  });

  it("denoises before the segment gain", () => {
    const f = buildCutFilter({ ...base, pieces: [{ ...pieces[0]!, volume: 2 }], denoise: true });
    expect(f.indexOf("afftdn")).toBeLessThan(f.indexOf("volume=2"));
  });
});

describe("loudness normalization", () => {
  const target = { target: -16, truePeak: -1.5 };
  const stderr = `[Parsed_loudnorm_0 @ 0x55]
{
\t"input_i" : "-23.41",
\t"input_tp" : "-6.20",
\t"input_lra" : "5.30",
\t"input_thresh" : "-33.71",
\t"output_i" : "-16.02",
\t"output_tp" : "-1.50",
\t"output_lra" : "4.90",
\t"output_thresh" : "-26.40",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.02"
}`;

  it("reads the measurement ffmpeg prints", () => {
    expect(parseLoudnorm(stderr)).toEqual({ input_i: -23.41, input_tp: -6.2, input_lra: 5.3, input_thresh: -33.71, target_offset: 0.02 });
  });

  it("returns undefined for silence or garbage", () => {
    expect(parseLoudnorm('{ "input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "0.00", "input_thresh" : "-70.00", "target_offset" : "inf" }')).toBeUndefined();
    expect(parseLoudnorm("no json here")).toBeUndefined();
  });

  it("measures audio only", () => {
    const a = buildMeasureArgs("in.mp4", target);
    expect(a).toContain("-vn");
    expect(a.join(" ")).toContain("loudnorm=I=-16:TP=-1.5:LRA=50:print_format=json");
    expect(a.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("picks the audio codec and flags the container takes", () => {
    const m = parseLoudnorm(stderr)!;
    const args = (out: string) => buildLoudnormArgs("in.mp4", out, target, m).join(" ");
    for (const out of ["out.mp4", "OUT.MP4", "out.mov", "out.m4v"]) {
      expect(args(out)).toContain("-c:a aac");
      expect(args(out)).toContain("-movflags +faststart");
    }
    expect(args("out.webm")).toContain("-c:a libopus");
    expect(args("out.webm")).not.toContain("movflags");
    expect(args("out.mkv")).toContain("-c:a aac");
    expect(args("out.mkv")).not.toContain("movflags");
  });

  it("applies the measurement linearly, keeps the picture and goes back to 48 kHz", () => {
    const m = parseLoudnorm(stderr)!;
    const a = buildLoudnormArgs("in.mp4", "out.mp4", target, m);
    const filter = a[a.indexOf("-af") + 1]!;
    expect(filter).toContain("I=-16:TP=-1.5:LRA=50");
    expect(filter).toContain("measured_I=-23.41:measured_TP=-6.2:measured_LRA=5.3:measured_thresh=-33.71:offset=0.02:linear=true");
    expect(filter).toMatch(/aresample=48000$/);
    expect(a.join(" ")).toContain("-c:v copy");
    expect(a.at(-1)).toBe("out.mp4");
  });
});
