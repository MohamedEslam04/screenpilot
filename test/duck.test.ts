import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import { planDuck } from "../src/render/duck.js";
import { buildPlan } from "../src/render/plan.js";
import { MusicSchema, StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const opts = { amount: 0.6, attack: 0.2, release: 0.5 };

describe("planDuck", () => {
  it("ramps down to music*(1-amount) before a line and back after it", () => {
    const t = planDuck([{ start: 2, end: 4 }], 0.2, opts, 10);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ t: 1.8, dur: 0.2, from: 0.2, to: 0.08 });
    expect(t[1]).toMatchObject({ t: 4, dur: 0.5, from: 0.08, to: 0.2 });
  });

  it("stays ducked between lines that are closer than attack+release", () => {
    const t = planDuck(
      [
        { start: 2, end: 4 },
        { start: 4.5, end: 6 },
      ],
      0.2,
      opts,
      10,
    );
    expect(t).toHaveLength(2);
    expect(t[0]!.t).toBe(1.8);
    expect(t[1]).toMatchObject({ t: 6, to: 0.2 });
  });

  it("comes back up fully between lines that are far apart", () => {
    const t = planDuck(
      [
        { start: 2, end: 3 },
        { start: 8, end: 9 },
      ],
      0.2,
      opts,
      12,
    );
    expect(t.map((x) => x.to)).toEqual([0.08, 0.2, 0.08, 0.2]);
  });

  it("handles unsorted and overlapping spans", () => {
    const t = planDuck(
      [
        { start: 5, end: 7 },
        { start: 1, end: 6 },
      ],
      0.1,
      opts,
      10,
    );
    expect(t).toHaveLength(2);
    expect(t[0]!.t).toBeCloseTo(0.8, 6);
    expect(t[1]!.t).toBe(7);
  });

  it("clips the ramp at the start and at the end of the video", () => {
    const t = planDuck([{ start: 0.1, end: 9.9 }], 0.2, opts, 10);
    expect(t[0]).toMatchObject({ t: 0, dur: 0.1 });
    expect(t[1]).toMatchObject({ t: 9.9, dur: 0.1 });
    // a line already playing at 0 ducks instantly
    expect(planDuck([{ start: 0, end: 1 }], 0.2, opts, 10)[0]).toMatchObject({ t: 0, dur: 0 });
  });

  it("does nothing without lines or with amount 0, and amount 1 mutes", () => {
    expect(planDuck([], 0.2, opts, 10)).toEqual([]);
    expect(planDuck([{ start: 1, end: 2 }], 0.2, { ...opts, amount: 0 }, 10)).toEqual([]);
    expect(planDuck([{ start: 1, end: 2 }], 0.2, { ...opts, amount: 1 }, 10)[0]!.to).toBe(0);
  });
});

describe("music.duck in the schema", () => {
  it("is off unless given, and fills in the defaults", () => {
    expect(MusicSchema.parse({ src: "m.mp3" }).duck).toBeUndefined();
    expect(MusicSchema.parse({ src: "m.mp3", duck: {} }).duck).toEqual({ amount: 0.6, attack: 0.2, release: 0.5 });
    expect(MusicSchema.safeParse({ src: "m.mp3", duck: { amount: 1.5 } }).success).toBe(false);
  });
});

describe("music ducking in the plan and html", () => {
  const sb = StoryboardSchema.parse({ source: "r.mp4", music: { src: "m.mp3", volume: 0.2, duck: {} } });
  const plan = (withDuck = true) =>
    buildPlan({
      sb: withDuck ? sb : { ...sb, music: { ...sb.music!, duck: undefined } },
      timeline: buildTimeline({ segments: [], holds: [], sourceDuration: 10 }),
      editedSrc: "e.mp4",
      editedHasAudio: false,
      source: { width: 1920, height: 1080 },
      narration: [{ text: "hi", voice: "v", rate: "+0%", file: "/x.mp3", duration: 2, at: 3, caption: false, src: "voice/x.mp3" }],
      clicks: [],
      musicSrc: "music.mp3",
    });

  it("puts the envelope on the music item only", () => {
    const [voice, music] = plan().audio;
    expect(voice!.duck).toBeUndefined();
    expect(music!.duck).toEqual([
      { t: 2.8, dur: 0.2, from: 0.2, to: 0.08 },
      { t: 5, dur: 0.5, from: 0.08, to: 0.2 },
    ]);
    expect(plan(false).audio[1]!.duck).toBeUndefined();
  });

  it("drives the audio element's volume from the GSAP timeline, deterministically", () => {
    const html = renderHtml(plan(), { gsapSrc: "g.js" });
    expect(html).toContain('tl.fromTo("#au1", { volume: 0.2 }, { volume: 0.08, duration: 0.2, ease: "none", immediateRender: false }, 2.8);');
    expect(html).toContain('tl.fromTo("#au1", { volume: 0.08 }, { volume: 0.2, duration: 0.5, ease: "none", immediateRender: false }, 5);');
    expect(renderHtml(plan(), { gsapSrc: "g.js" })).toBe(html);
  });
});
