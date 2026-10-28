import { describe, expect, it } from "vitest";
import { overlayKind } from "../src/render/overlay.js";
import { renderHtml } from "../src/render/html.js";
import { buildPlan, type PlanInput } from "../src/render/plan.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const box = { x: 0.8, y: 0.05, w: 0.15, h: 0.1 };

describe("overlays in the schema", () => {
  it("applies the defaults", () => {
    const sb = StoryboardSchema.parse({ source: "r.mp4", overlays: [{ src: "logo.png", ...box }] });
    expect(sb.overlays[0]).toMatchObject({ src: "logo.png", fit: "contain", opacity: 1, mute: true, loop: false });
    expect(sb.overlays[0]!.at).toBeUndefined();
    expect(sb.overlays[0]!.dur).toBeUndefined();
  });

  it("rejects positions outside 0..1, a bad opacity and a missing box", () => {
    const parse = (o: unknown) => StoryboardSchema.safeParse({ source: "r.mp4", overlays: [o] }).success;
    expect(parse({ src: "a.png", ...box, x: 1.2 })).toBe(false);
    expect(parse({ src: "a.png", ...box, opacity: 2 })).toBe(false);
    expect(parse({ src: "a.png", ...box, fit: "stretch" })).toBe(false);
    expect(parse({ src: "a.png", x: 0, y: 0 })).toBe(false);
    expect(parse({ src: "a.png", ...box, motion: { in: "pop", out: "fade" }, radius: 12, shadow: true })).toBe(true);
  });

  it("defaults to no overlays", () => {
    expect(StoryboardSchema.parse({ source: "r.mp4" }).overlays).toEqual([]);
  });
});

describe("overlayKind", () => {
  it("tells images from videos by extension", () => {
    expect(overlayKind("logo.PNG")).toBe("image");
    expect(overlayKind("a/b/pic.svg")).toBe("image");
    expect(overlayKind("clip.mp4")).toBe("video");
    expect(overlayKind("clip.webm")).toBe("video");
    expect(overlayKind("notes.txt")).toBeUndefined();
  });
});

function planOf(overlays: unknown[], assets: PlanInput["overlays"], opts: { intro?: number; segments?: unknown[] } = {}) {
  const sb = StoryboardSchema.parse({
    source: "r.mp4",
    intro: opts.intro ? { title: "Hi", dur: opts.intro } : undefined,
    segments: opts.segments ?? [],
    overlays,
  });
  const timeline = buildTimeline({ segments: sb.segments, holds: [], sourceDuration: 20, offset: opts.intro ?? 0 });
  return buildPlan({
    sb,
    timeline,
    editedSrc: "edited.mp4",
    editedHasAudio: false,
    source: { width: 1920, height: 1080 },
    narration: [],
    clicks: [],
    overlays: assets,
  });
}

describe("overlays in the plan", () => {
  it("lasts the whole video (not the cards) when at and dur are omitted", () => {
    const p = planOf([{ src: "logo.png", ...box }], [{ src: "overlays/0.png", kind: "image" }], { intro: 2 });
    expect(p.overlays).toHaveLength(1);
    expect(p.overlays[0]).toMatchObject({ src: "overlays/0.png", kind: "image", start: 2, end: 22, ...box, fit: "contain", opacity: 1 });
  });

  it("maps source time to output time through cuts and speed", () => {
    const segments = [
      { in: 0, out: 4, speed: 1 },
      { in: 10, out: 20, speed: 2 },
    ];
    const p = planOf([{ src: "a.png", ...box, at: 12, dur: 4 }], [{ src: "overlays/0.png", kind: "image" }], { segments });
    expect(p.overlays[0]).toMatchObject({ start: 5, end: 7 });
  });

  it("runs to the end of the video when only at is given, and starts at the beginning when only dur is", () => {
    const a = planOf([{ src: "a.png", ...box, at: 5 }], [{ src: "o/0.png", kind: "image" }]);
    expect(a.overlays[0]).toMatchObject({ start: 5, end: 20 });
    const b = planOf([{ src: "a.png", ...box, dur: 3 }], [{ src: "o/0.png", kind: "image" }]);
    expect(b.overlays[0]).toMatchObject({ start: 0, end: 3 });
  });

  it("drops an overlay whose start is cut out or whose file is missing", () => {
    const segments = [{ in: 0, out: 4, speed: 1 }];
    expect(planOf([{ src: "a.png", ...box, at: 8, dur: 2 }], [{ src: "o/0.png", kind: "image" }], { segments }).overlays).toEqual([]);
    expect(planOf([{ src: "a.png", ...box }], [undefined]).overlays).toEqual([]);
  });

  it("sends the sound of an unmuted video overlay through the audio plan", () => {
    const asset = { src: "overlays/0.mp4", kind: "video" as const, duration: 5, hasAudio: true };
    const unmuted = planOf([{ src: "v.mp4", ...box, at: 2, dur: 3, mute: false }], [asset]);
    expect(unmuted.audio).toEqual([{ src: "overlays/0.mp4", start: 2, duration: 3, volume: 1 }]);
    expect(planOf([{ src: "v.mp4", ...box, at: 2, dur: 3 }], [asset]).audio).toEqual([]);
    const silent = { ...asset, hasAudio: false };
    expect(planOf([{ src: "v.mp4", ...box, at: 2, dur: 3, mute: false }], [silent]).audio).toEqual([]);
  });

  it("tiles a looping video (and its sound) over the span", () => {
    const asset = { src: "overlays/0.mp4", kind: "video" as const, duration: 2, hasAudio: true };
    const p = planOf([{ src: "v.mp4", ...box, at: 1, dur: 5, loop: true, mute: false }], [asset]);
    expect(p.overlays[0]!.clips).toEqual([
      { start: 1, duration: 2 },
      { start: 3, duration: 2 },
      { start: 5, duration: 1 },
    ]);
    expect(p.audio.map((a) => [a.start, a.duration])).toEqual([
      [1, 2],
      [3, 2],
      [5, 1],
    ]);
  });

  it("plays a video once (clip length capped to the span) without loop", () => {
    const asset = { src: "overlays/0.mp4", kind: "video" as const, duration: 2, hasAudio: false };
    const p = planOf([{ src: "v.mp4", ...box, at: 1, dur: 5 }], [asset]);
    expect(p.overlays[0]!.clips).toEqual([{ start: 1, duration: 2 }]);
  });
});

describe("overlays in the html", () => {
  const html = renderHtml(
    planOf(
      [
        { src: "logo.png", ...box, opacity: 0.6, radius: 12, shadow: true, fit: "cover" },
        { src: "v.mp4", x: 0.1, y: 0.1, w: 0.3, h: 0.3, at: 2, dur: 3, motion: { in: "pop", out: "none" } },
      ],
      [
        { src: "overlays/0.png", kind: "image" },
        { src: "overlays/1.mp4", kind: "video", duration: 9, hasAudio: false },
      ],
    ),
    { gsapSrc: "g.js" },
  );

  it("places an image on the output frame, timed over the whole video", () => {
    expect(html).toMatch(/<div id="ov0" class="ov" style="left:1536px;top:54px;width:288px;height:108px">/);
    expect(html).toMatch(/<img id="ov0m0" class="clip ov-media" data-start="0" data-duration="20" src="overlays\/0.png"/);
    expect(html).toContain("object-fit:cover");
    expect(html).toContain("opacity:0.6");
    expect(html).toContain("border-radius:12px");
    expect(html).toContain("box-shadow:");
  });

  it("embeds a video muted and timed like the main video", () => {
    expect(html).toMatch(/<video id="ov1m0" class="clip ov-media" data-start="2" data-duration="3" src="overlays\/1.mp4" muted playsinline/);
  });

  it("fades by default and uses the chosen motion", () => {
    expect(html).toContain('tl.fromTo("#ov0", { opacity: 0 }, { opacity: 1');
    expect(html).toContain('tl.fromTo("#ov1", { opacity: 0, scale: 0.6 }');
  });

  it("sits above the recording and below the cards", () => {
    expect(html.indexOf('id="ov0"')).toBeGreaterThan(html.indexOf('id="frame"'));
  });
});
