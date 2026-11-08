import { describe, expect, it } from "vitest";
import { busySpans, type ChunkSources, chunkKey, planChunks, timelineBusy } from "../src/render/chunks.js";
import type { RenderPlan } from "../src/render/plan.js";
import { type Theme, ThemeSchema } from "../src/storyboard/schema.js";
import { buildTimeline, type Piece } from "../src/storyboard/timeline.js";

function plan(duration: number, extra: Partial<RenderPlan> = {}): RenderPlan {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    theme: {} as Theme,
    video: { src: "edited.mp4", start: 0, duration, hasAudio: false },
    frame: { left: 0, top: 0, w: 1920, h: 1080 },
    cam: { w: 1920, h: 1080 },
    camera: [],
    texts: [],
    highlights: [],
    annotations: [],
    keys: [],
    subtitles: [],
    ripples: [],
    audio: [],
    cards: [],
    overlays: [],
    ...extra,
  };
}

const starts = (chunks: { start: number }[]) => chunks.map((c) => c.start);
/** No chunk boundary strictly inside (a, b). */
const noCutInside = (chunks: { start: number }[], a: number, b: number) => expect(starts(chunks).filter((s) => s > a && s < b)).toEqual([]);

function expectContract(chunks: { start: number; end: number }[], duration: number, min: number) {
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(duration);
  chunks.forEach((c, i) => {
    if (i > 0) expect(c.start).toBe(chunks[i - 1]!.end);
    if (i < chunks.length - 1) expect(c.end - c.start).toBeGreaterThanOrEqual(min);
  });
}

describe("planChunks", () => {
  it("returns one chunk for a plan shorter than the target", () => {
    expect(planChunks(plan(150))).toEqual([{ start: 0, end: 150 }]);
  });

  it("returns one chunk when nothing is ever quiet", () => {
    const p = plan(900, { texts: [{ start: 0, end: 900, text: "always", position: "bottom", style: "pill" }] });
    expect(planChunks(p)).toEqual([{ start: 0, end: 900 }]);
  });

  it("follows the target when quiet points are plentiful", () => {
    expect(planChunks(plan(900))).toEqual([
      { start: 0, end: 180 },
      { start: 180, end: 360 },
      { start: 360, end: 540 },
      { start: 540, end: 720 },
      { start: 720, end: 900 },
    ]);
    expect(planChunks(plan(600), { target: 100 }).map((c) => c.end - c.start)).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it("cuts only on whole seconds (exact in ms and on every frame grid, draft fps included)", () => {
    const chunks = planChunks(plan(700.4), { target: 90 });
    for (const c of chunks.slice(1)) expect(Number.isInteger(c.start)).toBe(true);
    expect(chunks.at(-1)!.end).toBe(700.4);
  });

  it("keeps chunks contiguous, covering the plan, each at least `min` long but the last", () => {
    const texts = Array.from({ length: 40 }, (_, i) => ({ start: i * 23.7, end: i * 23.7 + 9.3, text: "x", position: "bottom" as const, style: "pill" as const }));
    const chunks = planChunks(plan(950.25, { texts }), { target: 120, min: 40 });
    expect(chunks.length).toBeGreaterThan(3);
    expectContract(chunks, 950.25, 40);
  });

  it("never leaves a last chunk shorter than `min`", () => {
    const chunks = planChunks(plan(370));
    expect(chunks).toEqual([
      { start: 0, end: 180 },
      { start: 180, end: 370 },
    ]);
  });

  // Review Focus 1: every kind of item that straddles a candidate point rejects it.
  describe("rejects a cut point straddled by", () => {
    const straddle = (p: RenderPlan, busy?: { start: number; end: number }[]) => {
      const chunks = planChunks(p, { busy });
      expect(chunks.length).toBeGreaterThan(1);
      return chunks;
    };

    it("a narration clip", () => {
      const p = plan(900, {
        audio: [{ src: "voice/0123456789abcdef.mp3", start: 178.6, duration: 3.1, volume: 1 }],
        subtitles: [{ start: 178.6, end: 181.7, text: "Hello" }],
      });
      noCutInside(straddle(p), 178.6, 181.7);
    });

    it("a narration clip even without its subtitle cue", () => {
      const p = plan(900, { audio: [{ src: "voice/ext-0.wav", start: 178.6, duration: 3.1, volume: 1 }] });
      noCutInside(straddle(p), 178.6, 181.7);
    });

    it("a hold (freeze) of the timeline", () => {
      const tl = buildTimeline({ segments: [], holds: [{ at: 179.5, dur: 2 }], sourceDuration: 900 });
      noCutInside(straddle(plan(902), timelineBusy(tl)), 179.5, 181.5);
    });

    it("a segment transition (the blend overlap)", () => {
      const tl = buildTimeline({
        segments: [
          { in: 0, out: 180.5, speed: 1 },
          { in: 200, out: 900, speed: 1, transition: { type: "crossfade", dur: 1 } },
        ],
        holds: [],
        sourceDuration: 900,
      });
      expect(timelineBusy(tl)).toEqual([{ start: 179.5, end: 180.5 }]);
      noCutInside(straddle(plan(tl.videoEnd), timelineBusy(tl)), 179.5, 180.5);
    });

    it("a chapter card", () => {
      const p = plan(900, { cards: [{ start: 179, dur: 3, fadeIn: 0.3, fadeOut: 0.3, title: "Part 2" }] });
      noCutInside(straddle(p), 179, 182);
    });

    it("a camera move in progress", () => {
      const p = plan(900, { camera: [{ t: 179.7, dur: 0.6, x: 0.2, y: 0.3, scale: 2 }] });
      noCutInside(straddle(p), 179.7, 180.3);
    });

    it("an overlay video", () => {
      const p = plan(900, {
        overlays: [{ src: "overlays/0.mp4", kind: "video", start: 150, end: 210, x: 0, y: 0, w: 0.3, h: 0.3, fit: "contain", opacity: 1, clips: [{ start: 150, duration: 60 }] }],
      });
      noCutInside(straddle(p), 150, 210);
    });

    it("a music fade-in", () => {
      const p = plan(900, { audio: [{ src: "music-track.wav", start: 179, duration: 600, volume: 0.3, fadeIn: 2 }] });
      noCutInside(straddle(p), 179, 181);
    });

    it("a music fade-out", () => {
      const p = plan(900, { audio: [{ src: "music.mp3", start: 0, duration: 181, volume: 0.3, fadeOut: 2 }] });
      noCutInside(straddle(p), 179, 181);
    });

    it("an sfx track fade", () => {
      const p = plan(900, { audio: [{ src: "sfx.wav", start: 0, duration: 180.5, volume: 1, fadeOut: 1 }] });
      noCutInside(straddle(p), 179.5, 180.5);
    });

    it("a music duck ramp", () => {
      const p = plan(900, { audio: [{ src: "music.mp3", start: 0, duration: 900, volume: 0.3, duck: [{ t: 179.8, dur: 0.4, from: 0.3, to: 0.1 }] }] });
      noCutInside(straddle(p), 179.8, 180.2);
    });

    it.each([
      ["a caption", { texts: [{ start: 179, end: 182, text: "Hi", position: "bottom", style: "pill" }] }],
      ["a highlight", { highlights: [{ start: 179, end: 182, x: 0, y: 0, w: 0.1, h: 0.1 }] }],
      ["an annotation", { annotations: [{ start: 179, end: 182, kind: "blur", x: 0, y: 0, w: 0.1, h: 0.1, mode: "solid", strength: 1, color: "#000" }] }],
      ["typed keys", { keys: [{ start: 179, end: 182, words: [{ text: "hi", at: 179.5 }] }] }],
      ["a click ripple (0.7 s)", { ripples: [{ t: 179.6, x: 0.5, y: 0.5 }] }],
    ] as [string, Partial<RenderPlan>][])("%s", (_name, extra) => {
      const chunks = straddle(plan(900, extra));
      expect(starts(chunks)).not.toContain(180);
    });
  });

  it("allows a cut through a held zoom (only the moves are busy)", () => {
    // Zoom in 170..170.6, held, zoom out 190..190.6: 180 is inside the held state.
    const p = plan(900, {
      camera: [
        { t: 170, dur: 0.6, x: 0.2, y: 0.3, scale: 2 },
        { t: 190, dur: 0.6, x: 0.5, y: 0.5, scale: 1 },
      ],
    });
    expect(starts(planChunks(p)).some((t) => t > 170.6 && t < 190)).toBe(true);
  });

  it("allows a cut through a full-length image overlay (only its entrance and exit are busy)", () => {
    const p = plan(900, {
      overlays: [{ src: "overlays/0.png", kind: "image", start: 0, end: 900, x: 0.9, y: 0.9, w: 0.1, h: 0.1, fit: "contain", opacity: 1, clips: [{ start: 0, duration: 900 }] }],
    });
    expect(starts(planChunks(p)).filter((t) => t > 3 && t < 897)).toHaveLength(4);
    expect(busySpans(p)).toEqual([
      { start: 0, end: 3 },
      { start: 897, end: 900 },
    ]);
  });

  it("allows a cut through a music bed (only its fades are busy)", () => {
    const p = plan(900, { audio: [{ src: "music.mp3", start: 0, duration: 900, volume: 0.3, fadeIn: 1.5, fadeOut: 3 }] });
    expect(starts(planChunks(p)).filter((t) => t > 1.5 && t < 897)).toHaveLength(4);
  });

  // Review Focus 4: boundaries follow the content, so a whole-second shift in one chunk
  // moves every later boundary by the same amount and later chunk slices stay identical.
  it("moves every later boundary with the content when an edit shifts it by whole seconds", () => {
    const texts = Array.from({ length: 30 }, (_, i) => ({ start: 7 + i * 31.3, end: 7 + i * 31.3 + 12, text: "x", position: "bottom" as const, style: "pill" as const }));
    const before = planChunks(plan(950, { texts }));
    const shift = (t: number) => (t > 100 ? t + 2 : t);
    const after = planChunks(plan(952, { texts: texts.map((t) => ({ ...t, start: shift(t.start), end: shift(t.end) })) }));
    expect(before.length).toBeGreaterThan(3);
    expect(after.slice(1).map((c) => c.start)).toEqual(before.slice(1).map((c) => c.start + 2));
  });

  it("moves the next boundary too when the edit sits in the same quiet gap", () => {
    const texts = (shift: number) => [20, 150, 250, 350].map((t) => ({ start: t > 50 ? t + shift : t, end: (t > 50 ? t + shift : t) + 3, text: "x", position: "bottom" as const, style: "pill" as const }));
    expect(starts(planChunks(plan(400, { texts: texts(0) }), { target: 100 }))).toEqual([0, 100, 200, 300]);
    // A 2 s hold at 50 s (busy) pushes everything after it.
    const after = planChunks(plan(402, { texts: texts(2) }), { target: 100, busy: [{ start: 50, end: 52 }] });
    expect(starts(after)).toEqual([0, 102, 202, 302]);
  });
});

describe("chunkKey", () => {
  const theme = ThemeSchema.parse({});
  const caption = (start: number, text = "x") => ({ start, end: start + 3, text, position: "bottom" as const, style: "pill" as const });
  /** A 400 s plan cut from one source range; `shift` seconds of hold inserted at 50 s push everything after it. */
  function scene(shift = 0, captionText = "Second") {
    const pieces: Piece[] = shift
      ? [
          { kind: "play", in: 0, out: 50, speed: 1, volume: 1, outStart: 0, outEnd: 50 },
          { kind: "hold", at: 50, dur: shift, outStart: 50, outEnd: 50 + shift },
          { kind: "play", in: 50, out: 400, speed: 1, volume: 1, outStart: 50 + shift, outEnd: 400 + shift },
        ]
      : [{ kind: "play", in: 0, out: 400, speed: 1, volume: 1, outStart: 0, outEnd: 400 }];
    const s = (t: number) => (t >= 50 ? t + shift : t);
    const full = plan(400 + shift, {
      theme,
      texts: [caption(20, "First"), caption(s(150), captionText), caption(s(250), "Third")],
    });
    const sources: ChunkSources = { files: {}, video: { src: "edited.mp4", cut: "rec.mp4|1|2|30", pieces } };
    return { full, sources };
  }
  const key = (sc: ReturnType<typeof scene>, start: number, end: number, render = "draft") => chunkKey(sc.full, { start, end }, sc.sources, render);

  it("is the same for an unchanged chunk and differs with the render settings", () => {
    expect(key(scene(), 100, 200)).toBe(key(scene(), 100, 200));
    expect(key(scene(), 100, 200, "delivery")).not.toBe(key(scene(), 100, 200));
  });

  // Review Focus 3: keys depend only on the chunk's own slice, never on its index or on other chunks.
  it("changes only for the chunk whose caption changed", () => {
    const a = scene();
    const b = scene(0, "Second, edited");
    expect(key(b, 0, 100)).toBe(key(a, 0, 100));
    expect(key(b, 100, 200)).not.toBe(key(a, 100, 200));
    expect(key(b, 200, 300)).toBe(key(a, 200, 300));
  });

  // Review Focus 4: chunk-relative times, and the cut described by what the chunk shows,
  // so a chunk whose slice is identical after a shift keeps its key.
  it("survives a whole-second shift of everything after an earlier edit", () => {
    const a = scene();
    const b = scene(2);
    expect(key(b, 0, 100)).not.toBe(key(a, 0, 100));
    expect(key(b, 102, 202)).toBe(key(a, 100, 200));
    expect(key(b, 202, 402)).toBe(key(a, 200, 400));
  });

  it("changes when the shifted chunk does not show the same source frames", () => {
    expect(key(scene(2), 100, 200)).not.toBe(key(scene(), 100, 200));
  });

  it("changes when the source or the cut settings change", () => {
    const b = scene();
    b.sources.video.cut = "rec.mp4|1|3|30";
    expect(key(b, 100, 200)).not.toBe(key(scene(), 100, 200));
  });

  // Review Focus 2: music keeps its absolute offset, so a chunk that now hears another part of the song re-renders.
  it("changes when the music under a shifted chunk is another part of the song", () => {
    const music = (sc: ReturnType<typeof scene>) => {
      sc.full.audio = [{ src: "music.mp3", start: 0, duration: sc.full.duration, volume: 0.3 }];
      sc.sources.files["music.mp3"] = "song:1:2";
      return sc;
    };
    const a = music(scene());
    expect(key(music(scene(2)), 102, 202)).not.toBe(key(a, 100, 200));
    expect(key(music(scene()), 100, 200)).toBe(key(a, 100, 200));
  });

  it("keys a file by its content identity, not by its build-dir name", () => {
    const a = scene();
    a.full.audio = [{ src: "voice/ext-3.wav", start: 120, duration: 2, volume: 1 }];
    a.sources.files["voice/ext-3.wav"] = "line.wav:10:20";
    const b = scene();
    b.full.audio = [{ src: "voice/ext-4.wav", start: 120, duration: 2, volume: 1 }];
    b.sources.files["voice/ext-4.wav"] = "line.wav:10:20";
    expect(key(b, 100, 200)).toBe(key(a, 100, 200));
    b.sources.files["voice/ext-4.wav"] = "line.wav:11:20";
    expect(key(b, 100, 200)).not.toBe(key(a, 100, 200));
  });

  it("keys the sound effects track by the hits the chunk hears, chunk-relative", () => {
    const withSfx = (sc: ReturnType<typeof scene>, hits: number[]) => {
      sc.full.audio = [{ src: "sfx.wav", start: 0, duration: sc.full.duration, volume: 1 }];
      sc.sources.sfx = { src: "sfx.wav", hits: hits.map((at) => ({ at, volume: 0.5, sound: "builtin:click" })) };
      return sc;
    };
    const a = withSfx(scene(), [30, 130, 230]);
    const b = withSfx(scene(2), [31, 132, 232]);
    expect(key(b, 0, 100)).not.toBe(key(a, 0, 100));
    expect(key(b, 102, 202)).toBe(key(a, 100, 200));
    expect(key(b, 202, 402)).toBe(key(a, 200, 400));
  });
});
