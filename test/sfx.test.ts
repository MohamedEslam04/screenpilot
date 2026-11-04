import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import { buildPlan } from "../src/render/plan.js";
import { lintStyle } from "../src/storyboard/lint.js";
import { BUILTIN_SFX, builtinSfxInput, buildSfxMix, planSfx, sfxInput, typingPresses } from "../src/render/sfx.js";
import { windowPlan } from "../src/render/window.js";
import { SfxSchema, SoundsSchema, StoryboardSchema, TypingSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

function sbOf(extra: Record<string, unknown>) {
  return StoryboardSchema.parse({ source: "r.mp4", ...extra });
}

function plan(extra: Record<string, unknown>, o: { clicks?: { t: number; x: number; y: number }[]; duration?: number } = {}) {
  const sb = sbOf(extra);
  // Chapter cards are holds, as in prepareBuild.
  const holds = sb.cards.map((c, card) => ({ at: c.at, dur: c.dur, card }));
  const timeline = buildTimeline({ segments: sb.segments, holds, sourceDuration: o.duration ?? 20, offset: sb.intro?.dur ?? 0 });
  const total = timeline.videoEnd + (sb.outro?.dur ?? 0);
  return planSfx({ sb, timeline, clicks: o.clicks ?? [], duration: total });
}

describe("sfx in the schema", () => {
  it("defaults to no sounds", () => {
    const sb = sbOf({});
    expect(sb.sfx).toEqual([]);
    expect(sb.typing).toEqual([]);
    expect(sb.sounds).toBeUndefined();
  });

  it("applies the defaults and rejects bad values", () => {
    expect(SfxSchema.parse({ at: 1, src: "builtin:pop" })).toEqual({ at: 1, src: "builtin:pop", volume: 1 });
    expect(SfxSchema.safeParse({ at: -1, src: "a.wav" }).success).toBe(false);
    expect(SfxSchema.safeParse({ at: 1, src: "" }).success).toBe(false);
    expect(SfxSchema.safeParse({ at: 1, src: "a.wav", volume: 9 }).success).toBe(false);
    expect(SoundsSchema.parse({ clicks: true, typing: "pop" })).toMatchObject({ clicks: true, typing: "pop", volume: 0.5 });
    expect(TypingSchema.parse({ at: 2 })).toEqual({ at: 2, dur: 3 });
    expect(TypingSchema.parse({ at: 2, dur: 1.5, text: "hello" })).toEqual({ at: 2, dur: 1.5, text: "hello" });
    expect(TypingSchema.safeParse({ at: 2, dur: 0 }).success).toBe(false);
    expect(TypingSchema.safeParse({ at: -1 }).success).toBe(false);
    expect(SoundsSchema.safeParse({ volume: 3 }).success).toBe(false);
  });
});

describe("typingPresses", () => {
  it("makes one press per character, or about 7 a second without text", () => {
    expect(typingPresses({ at: 2, dur: 3, text: "hello world" }, 0)).toHaveLength(11);
    expect(typingPresses({ at: 2, dur: 3 }, 0)).toHaveLength(21);
    expect(typingPresses({ at: 2, dur: 3, text: "" }, 0)).toEqual([]);
  });

  it("keeps every press inside the span, in order, and is repeatable", () => {
    const a = typingPresses({ at: 10, dur: 2, text: "some typing here" }, 3);
    expect(a).toEqual(typingPresses({ at: 10, dur: 2, text: "some typing here" }, 3));
    expect(a).toEqual([...a].sort((x, y) => x - y));
    expect(a.every((t) => t >= 10 && t < 12)).toBe(true);
  });

  it("is not perfectly even, but differs between spans", () => {
    const a = typingPresses({ at: 0, dur: 2, text: "abcdefghij" }, 0);
    const gaps = a.slice(1).map((t, i) => +(t - a[i]!).toFixed(4));
    expect(new Set(gaps).size).toBeGreaterThan(1);
    expect(typingPresses({ at: 0, dur: 2, text: "abcdefghij" }, 1)).not.toEqual(a);
  });
});

describe("builtin sounds", () => {
  it("has an ffmpeg source for every name", () => {
    for (const name of BUILTIN_SFX) {
      const input = builtinSfxInput(name);
      expect(input.slice(0, 2)).toEqual(["-f", "lavfi"]);
      expect(input[3]).toContain("48000");
    }
  });

  it("resolves builtin: names and file paths", () => {
    const builtin = sfxInput("builtin:click", "/base")!;
    expect(builtin.id).toBe("builtin:click");
    expect(builtin.file).toBeUndefined();
    const file = resolve("/base", "a/b.wav");
    expect(sfxInput("a/b.wav", "/base")).toEqual({ id: file, file, input: ["-i", file] });
    expect(sfxInput("builtin:nope", "/base")).toBeUndefined();
  });
});

describe("planSfx", () => {
  it("maps explicit sfx through the timeline and drops cut regions", () => {
    const r = plan({ segments: [{ in: 5, out: 15 }], sfx: [{ at: 6, src: "builtin:pop", volume: 0.5 }, { at: 2, src: "builtin:pop" }] });
    expect(r.hits).toEqual([{ src: "builtin:pop", at: 1, volume: 0.5 }]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("sfx[1]");
  });

  it("adds the intro offset", () => {
    const r = plan({ intro: { title: "Hi", dur: 2 }, sfx: [{ at: 1, src: "builtin:pop" }] });
    expect(r.hits[0]!.at).toBe(3);
  });

  it("plays a click sound on every recorded click at sounds.volume", () => {
    const r = plan({ sounds: { clicks: true, volume: 0.4 } }, { clicks: [{ t: 3, x: 0, y: 0 }, { t: 7, x: 0, y: 0 }] });
    expect(r.hits).toEqual([
      { src: "builtin:click", at: 3, volume: 0.4 },
      { src: "builtin:click", at: 7, volume: 0.4 },
    ]);
  });

  it("accepts a custom sound name or file for clicks", () => {
    const r = plan({ sounds: { clicks: "mine.wav" } }, { clicks: [{ t: 3, x: 0, y: 0 }] });
    expect(r.hits[0]!.src).toBe("mine.wav");
  });

  it("does nothing for sounds that are off", () => {
    const typing = [{ at: 4, dur: 2 }];
    expect(plan({ sounds: { clicks: false, typing: false }, typing }, { clicks: [{ t: 3, x: 0, y: 0 }] }).hits).toEqual([]);
    expect(plan({ typing }, { clicks: [{ t: 3, x: 0, y: 0 }] }).hits).toEqual([]);
  });

  it("throttles click sounds that land within 50 ms of each other once the speed-up is applied", () => {
    const r = plan({ segments: [{ in: 0, out: 20, speed: 8 }], sounds: { clicks: true } }, { clicks: [{ t: 8, x: 0, y: 0 }, { t: 8.2, x: 0, y: 0 }, { t: 12, x: 0, y: 0 }] });
    expect(r.hits.map((h) => h.at)).toEqual([1, 1.5]);
  });

  it("plays a typing sound for each press of a typing span, at sounds.volume", () => {
    const r = plan({ sounds: { typing: true, volume: 0.3 }, typing: [{ at: 4, dur: 2, text: "hello" }] });
    expect(r.hits).toHaveLength(5);
    expect(r.hits.every((h) => h.src === "builtin:key" && h.volume === 0.3)).toBe(true);
    expect(r.hits.every((h) => h.at >= 4 && h.at < 6)).toBe(true);
  });

  it("maps typing presses through the timeline and skips the ones in cut regions", () => {
    const r = plan({ segments: [{ in: 5, out: 15 }], sounds: { typing: "pop" }, typing: [{ at: 3, dur: 4, text: "abcdefgh" }] });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.length).toBeLessThan(8);
    expect(r.hits.every((h) => h.src === "builtin:pop" && h.at >= 0 && h.at < 2)).toBe(true);
  });

  it("warns when a whole typing span is in a cut region", () => {
    const r = plan({ segments: [{ in: 5, out: 15 }], sounds: { typing: true }, typing: [{ at: 1, dur: 2, text: "abc" }] });
    expect(r.hits).toEqual([]);
    expect(r.warnings[0]).toContain("typing[0]");
  });

  it("drops auto sounds that fall in cut regions without warning", () => {
    const r = plan({ segments: [{ in: 5, out: 15 }], sounds: { clicks: true } }, { clicks: [{ t: 2, x: 0, y: 0 }, { t: 6, x: 0, y: 0 }] });
    expect(r.hits.map((h) => h.at)).toEqual([1]);
    expect(r.warnings).toEqual([]);
  });

  it("puts a whoosh on the intro, chapter cards and outro when sounds.cards is on", () => {
    const r = plan({
      intro: { title: "Hi", dur: 2 },
      outro: { title: "Bye", dur: 2 },
      cards: [{ at: 5, dur: 2, title: "Part 2" }],
      sounds: { cards: true },
    });
    const times = r.hits.map((h) => h.at);
    expect(r.hits.every((h) => h.src === "builtin:whoosh")).toBe(true);
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(2 + 5);
    // Intro 2 s + 20 s of video + the 2 s card hold; the outro cross-fades in over the last 0.5 s.
    expect(times[2]).toBeCloseTo(2 + 20 + 2 - 0.5, 3);
  });

});

describe("buildSfxMix", () => {
  const click = builtinSfxInput("click");
  const pop = builtinSfxInput("pop");

  it("delays every hit, gives each source once and mixes them over a silent track as long as the video", () => {
    const { inputs, filter } = buildSfxMix(
      [
        { id: "builtin:click", input: click, at: 1.5, volume: 0.5 },
        { id: "builtin:pop", input: pop, at: 0, volume: 1 },
        { id: "builtin:click", input: click, at: 4, volume: 0.5 },
      ],
      10,
    );
    expect(inputs).toEqual([...click, ...pop, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=10"]);
    expect(filter).toContain("[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2");
    expect(filter).toContain("[1:a]aformat=sample_rates=48000:channel_layouts=stereo,anull");
    expect(filter).toContain("adelay=1500|1500");
    expect(filter).toContain("adelay=4000|4000");
    expect(filter).toContain("volume=0.5");
    expect(filter).toContain("[2:a][h0][h1][h2]amix=inputs=4:normalize=0:duration=longest,atrim=end=10");
    expect(filter).toMatch(/alimiter=limit=0\.\d+\[out\]$/);
  });

  it("works for a single hit", () => {
    const { inputs, filter } = buildSfxMix([{ id: "builtin:pop", input: pop, at: 2, volume: 1 }], 5);
    expect(inputs.at(-1)).toBe("anullsrc=r=48000:cl=stereo:d=5");
    expect(filter).toContain("[1:a][h0]amix=inputs=2");
  });
});

describe("sfx in the plan", () => {
  const sb = sbOf({ sfx: [{ at: 2, src: "builtin:pop" }] });
  const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 10, offset: 0 });
  const base = { sb, timeline, editedSrc: "e.mp4", editedHasAudio: false, source: { width: 1920, height: 1080 }, narration: [], clicks: [] };

  it("adds one audio item spanning the video", () => {
    const p = buildPlan({ ...base, sfxSrc: "sfx.wav" });
    expect(p.audio).toEqual([{ src: "sfx.wav", start: 0, duration: 10, volume: 1 }]);
    expect(renderHtml(p, { gsapSrc: "g.js" })).toContain('src="sfx.wav"');
  });

  it("has no audio item without a mix, so old storyboards plan the same", () => {
    expect(buildPlan(base).audio).toEqual([]);
  });

  it("is trimmed by a partial render like any audio item", () => {
    const w = windowPlan(buildPlan({ ...base, sfxSrc: "sfx.wav" }), { from: 3, to: 6 });
    expect(w.audio).toEqual([{ src: "sfx.wav", start: 0, duration: 3, volume: 1, mediaStart: 3 }]);
  });
});

describe("lint for typing and sounds", () => {
  const lint = (extra: Record<string, unknown>) => lintStyle(sbOf(extra));

  it("warns when typing sounds are on but nothing is marked as typing", () => {
    expect(lint({ sounds: { typing: true } }).some((m) => /sounds\.typing.*typing/.test(m))).toBe(true);
    expect(lint({ sounds: { typing: true }, typing: [{ at: 1 }] })).toEqual([]);
  });

  it("warns about a typing span that makes no sound and shows nothing", () => {
    expect(lint({ typing: [{ at: 1, dur: 2, text: "hi" }] }).some((m) => /typing\[0\].*nothing/.test(m))).toBe(true);
    expect(lint({ typing: [{ at: 1, dur: 2, text: "hi", keycaps: true }] })).toEqual([]);
    expect(lint({ sounds: { typing: true }, typing: [{ at: 1 }] })).toEqual([]);
  });
});
