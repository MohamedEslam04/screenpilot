import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import type { RenderPlan } from "../src/render/plan.js";
import { parseWindow, partSuffix, windowPlan } from "../src/render/window.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";

const theme = StoryboardSchema.parse({ source: "a.mp4" }).theme;

// 3s intro, 20s video (output 3..23), 2s outro card overlapping the last 0.5s.
const plan: RenderPlan = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 24.5,
  theme,
  video: { src: "edited.mp4", start: 3, duration: 20, hasAudio: false },
  frame: { left: 96, top: 54, w: 1728, h: 972 },
  cam: { w: 1728, h: 972 },
  camera: [
    { t: 4, dur: 1, x: -100, y: -50, scale: 2 },
    { t: 10, dur: 1, x: 0, y: 0, scale: 1 },
    { t: 15, dur: 0, x: -10, y: -10, scale: 1.5 },
  ],
  texts: [
    { start: 5, end: 8, text: "early", position: "bottom", style: "pill" },
    { start: 12, end: 16, text: "inside", position: "bottom", style: "pill" },
    { start: 30, end: 31, text: "late", position: "bottom", style: "pill" },
  ],
  highlights: [{ start: 12, end: 14, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
  ripples: [
    { t: 11, x: 0.5, y: 0.5 },
    { t: 13, x: 0.5, y: 0.5 },
    { t: 40, x: 0.5, y: 0.5 },
  ],
  audio: [
    { src: "voice/a.mp3", start: 9, duration: 4, volume: 1 },
    { src: "voice/b.mp3", start: 14, duration: 2, volume: 1 },
    { src: "voice/c.mp3", start: 20, duration: 2, volume: 1 },
    { src: "music.mp3", start: 0, duration: 24.5, volume: 0.1, fadeIn: 1, fadeOut: 2 },
  ],
  cards: [
    { start: 0, dur: 3, fadeIn: 0, title: "Intro" },
    { start: 22.5, dur: 2, fadeIn: 0.5, title: "Outro" },
  ],
  overlays: [],
};

describe("parseWindow", () => {
  it.each([
    { from: 12, to: 20, expected: { from: 12, to: 20 } },
    { from: undefined, to: 20, expected: { from: 0, to: 20 } },
    { from: 12, to: undefined, expected: { from: 12, to: undefined } },
    { from: undefined, to: undefined, expected: undefined },
  ])("from=$from to=$to", ({ from, to, expected }) => {
    expect(parseWindow(from, to)).toEqual(expected);
  });

  it.each([
    { from: -1, to: 5 },
    { from: 5, to: 5 },
    { from: 8, to: 5 },
    { from: Number.NaN, to: 5 },
  ])("rejects from=$from to=$to", ({ from, to }) => {
    expect(() => parseWindow(from, to)).toThrow(/--from|--to|from|to/);
  });
});

describe("partSuffix", () => {
  it("names the window", () => {
    expect(partSuffix({ from: 12, to: 20 })).toBe(".part-12-20");
    expect(partSuffix({ from: 1.5, to: 20.25 })).toBe(".part-1.5-20.25");
    expect(partSuffix({ from: 12, to: undefined })).toBe(".part-12-end");
  });
});

describe("windowPlan", () => {
  const w = windowPlan(plan, { from: 12, to: 20 });

  it("starts at zero and lasts the window", () => {
    expect(w.duration).toBe(8);
  });

  it("trims the edited video from the window start", () => {
    // Output 12..20 is edited-video time 9..17.
    expect(w.video).toEqual({ src: "edited.mp4", start: 0, duration: 8, mediaStart: 9, hasAudio: false });
  });

  it("keeps the video start after an intro that is inside the window", () => {
    const x = windowPlan(plan, { from: 1, to: 10 });
    expect(x.video.start).toBe(2);
    expect(x.video.duration).toBe(7);
    expect(x.video.mediaStart).toBe(0);
  });

  it("drops items fully outside and shifts the rest", () => {
    expect(w.texts.map((t) => t.text)).toEqual(["inside"]);
    expect(w.texts[0]).toMatchObject({ start: 0, end: 4 });
    expect(w.highlights).toEqual([{ start: 0, end: 2, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
    expect(w.ripples).toEqual([{ t: 1, x: 0.5, y: 0.5 }]);
  });

  it("truncates items that straddle the window edges", () => {
    const x = windowPlan(plan, { from: 6, to: 13 });
    expect(x.texts.map((t) => [t.text, t.start, t.end])).toEqual([
      ["early", 0, 2],
      ["inside", 6, 7],
    ]);
  });

  it("aligns audio and trims partial clips with a media offset", () => {
    expect(w.audio).toEqual([
      // a: 9..13 -> window 12..13, starts 3s into the clip
      { src: "voice/a.mp3", start: 0, duration: 1, volume: 1, mediaStart: 3 },
      { src: "voice/b.mp3", start: 2, duration: 2, volume: 1 },
      // music runs through, loses its fade-in (cut mid-track) and fade-out (not at the end)
      { src: "music.mp3", start: 0, duration: 8, volume: 0.1, mediaStart: 12 },
    ]);
  });

  it("keeps music fades at the real start and end of the track", () => {
    const x = windowPlan(plan, { from: 0, to: 24.5 });
    // Only what lies past the end of the video (the "late" text, the 40s ripple) goes.
    expect(x).toEqual({
      ...plan,
      video: { ...plan.video, mediaStart: 0 },
      texts: plan.texts.slice(0, 2),
      ripples: plan.ripples.slice(0, 2),
    });
  });

  it("starts the camera where the full render would be at the window start", () => {
    // Window at 12: the 10..11 tween is done, so the camera rests at identity.
    expect(w.camera).toEqual([
      { t: 0, dur: 0, x: 0, y: 0, scale: 1 },
      { t: 3, dur: 0, x: -10, y: -10, scale: 1.5 },
    ]);
  });

  it("interpolates a camera tween that straddles the window start", () => {
    const x = windowPlan(plan, { from: 4.5, to: 20 });
    const [first, second, ...rest] = x.camera;
    // Halfway through an eased move from identity to scale 2.
    expect(first).toEqual({ t: 0, dur: 0, x: -50, y: -25, scale: 1.5 });
    expect(second).toEqual({ t: 0, dur: 0.5, x: -100, y: -50, scale: 2 });
    expect(rest.map((c) => c.t)).toEqual([5.5, 10.5]);
  });

  it("clips cards and drops their fade-in when cut", () => {
    const x = windowPlan(plan, { from: 1, to: 23 });
    expect(x.cards[0]).toMatchObject({ start: 0, dur: 2, fadeIn: 0 });
    expect(x.cards[1]).toMatchObject({ start: 21.5, dur: 0.5, fadeIn: 0.5 });
    const y = windowPlan(plan, { from: 22.75, to: 24 });
    expect(y.cards).toEqual([{ start: 0, dur: 1.25, fadeIn: 0, title: "Outro" }]);
  });

  it("without an end runs to the end of the video", () => {
    expect(windowPlan(plan, { from: 20, to: undefined }).duration).toBe(4.5);
  });

  it("clamps an end past the video", () => {
    expect(windowPlan(plan, { from: 20, to: 99 }).duration).toBe(4.5);
  });

  it("rejects a start past the end of the video", () => {
    expect(() => windowPlan(plan, { from: 30, to: 40 })).toThrow(/24\.5/);
  });

  it("a window inside a card has no video and renders", () => {
    const x = windowPlan(plan, { from: 1, to: 2 });
    expect(x.video.duration).toBe(0);
    expect(x.video.start).toBe(0);
    expect(renderHtml(x, { gsapSrc: "g.js" })).toContain('data-duration="1"');
  });
});

describe("renderHtml media offsets", () => {
  it("writes data-media-start only when the media is trimmed", () => {
    const html = renderHtml(windowPlan(plan, { from: 12, to: 20 }), { gsapSrc: "g.js" });
    expect(html).toMatch(/<video id="rec"[^>]*data-media-start="9"/);
    expect(html).toMatch(/<audio id="au0"[^>]*data-media-start="3"/);
    expect(html).not.toMatch(/<audio id="au1"[^>]*data-media-start/);
    expect(renderHtml(plan, { gsapSrc: "g.js" })).not.toContain("data-media-start");
  });
});

describe("windowPlan with overlays, ducking and chapter cards", () => {
  const rich: RenderPlan = {
    ...plan,
    overlays: [
      {
        src: "overlays/0.png",
        kind: "image",
        start: 3,
        end: 23,
        x: 0.8,
        y: 0.05,
        w: 0.15,
        h: 0.1,
        fit: "contain",
        opacity: 1,
        motion: { in: "pop", out: "fade" },
        clips: [{ start: 3, duration: 20 }],
      },
      {
        src: "overlays/1.mp4",
        kind: "video",
        start: 8,
        end: 16,
        x: 0.6,
        y: 0.6,
        w: 0.3,
        h: 0.3,
        fit: "cover",
        opacity: 1,
        clips: [{ start: 8, duration: 8 }],
      },
    ],
    audio: [
      {
        src: "music.mp3",
        start: 0,
        duration: 24.5,
        volume: 0.1,
        duck: [
          { t: 8.8, dur: 0.2, from: 0.1, to: 0.04 },
          { t: 13, dur: 0.5, from: 0.04, to: 0.1 },
        ],
      },
    ],
    cards: [{ start: 12, dur: 4, fadeIn: 0.3, fadeOut: 0.3, title: "Step 2" }],
  };

  it("shifts and clips overlays into the window", () => {
    const w = windowPlan(rich, { from: 10, to: 14 });
    const [logo, pip] = w.overlays;
    expect(logo).toMatchObject({ start: 0, end: 4, clips: [{ start: 0, duration: 4 }] });
    expect(pip).toMatchObject({ start: 0, end: 4, clips: [{ start: 0, duration: 4, mediaStart: 2 }] });
  });

  it("drops overlays fully outside the window", () => {
    const w = windowPlan(rich, { from: 17, to: 20 });
    expect(w.overlays).toHaveLength(1);
    expect(w.overlays[0]!.src).toBe("overlays/0.png");
  });

  it("does not replay an entrance when the window starts mid-overlay", () => {
    const w = windowPlan(rich, { from: 10, to: 14 });
    expect(w.overlays[0]!.motion?.in).toBe("none");
    expect(w.overlays[0]!.motion?.out).toBe("none");
  });

  it("keeps the entrance when the window starts with the overlay", () => {
    const w = windowPlan(rich, { from: 3, to: 14 });
    expect(w.overlays[0]!.motion?.in).toBe("pop");
  });

  it("starts the music at the ducked level when the window opens during a duck", () => {
    const w = windowPlan(rich, { from: 10, to: 20 });
    const music = w.audio[0]!;
    expect(music.volume).toBeCloseTo(0.04);
    expect(music.duck).toEqual([{ t: 3, dur: 0.5, from: 0.04, to: 0.1 }]);
  });

  it("finishes a ramp that is in progress at the window start", () => {
    const w = windowPlan(rich, { from: 13.25, to: 20 });
    const music = w.audio[0]!;
    expect(music.volume).toBeCloseTo(0.07);
    expect(music.duck).toEqual([{ t: 0, dur: 0.25, from: 0.07, to: 0.1 }]);
  });

  it("drops the card fade-out when the window cuts the card's tail", () => {
    const w = windowPlan(rich, { from: 10, to: 14 });
    expect(w.cards[0]).toMatchObject({ start: 2, dur: 2, fadeIn: 0.3 });
    expect(w.cards[0]!.fadeOut).toBe(0);
  });

  it("renders the overlay media offset into the html", () => {
    const html = renderHtml(windowPlan(rich, { from: 10, to: 14 }), { gsapSrc: "gsap.min.js" });
    expect(html).toMatch(/id="ov1m0"[^>]*data-media-start="2"/);
  });
});
