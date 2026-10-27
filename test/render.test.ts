import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import { buildPlan, frameBox } from "../src/render/plan.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const sb = StoryboardSchema.parse({
  source: "rec.mp4",
  intro: { title: "Hello <World>", dur: 2 },
  outro: { title: "Bye", dur: 2 },
  zooms: [{ at: 1, dur: 2, x: 0.5, y: 0.5, scale: 2 }],
  captions: [
    { at: 0.5, text: "Top", position: "top" },
    { at: 3, text: "Point here", style: "callout", x: 0.2, y: 0.1 },
    { at: 4, text: "Bottom pill" },
  ],
  highlights: [{ at: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "Here" }],
});

function plan() {
  const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 10, offset: 2 });
  return buildPlan({
    sb,
    timeline,
    editedSrc: "edited.mp4",
    editedHasAudio: false,
    source: { width: 1920, height: 1080 },
    narration: [
      { text: "مرحبا", voice: "ar-EG-SalmaNeural", rate: "+0%", file: "/x.mp3", duration: 2, at: 3.5, caption: true, src: "voice/x.mp3" },
    ],
    clicks: [{ t: 1, x: 0.5, y: 0.5 }],
  });
}

describe("frameBox", () => {
  it("fits the recording inside the padding, centered", () => {
    expect(frameBox(1920, 1080, 1920, 1080, 0.05)).toEqual({ left: 171, top: 96, w: 1579, h: 888 });
  });

  it("letterboxes a tall recording", () => {
    const b = frameBox(1920, 1080, 1080, 1920, 0);
    expect(b.h).toBe(1080);
    expect(b.left).toBe(Math.round((1920 - b.w) / 2));
  });
});

describe("buildPlan", () => {
  it("maps everything to output time after the intro", () => {
    const p = plan();
    expect(p.duration).toBe(14);
    expect(p.video).toMatchObject({ start: 2, duration: 10 });
    expect(p.ripples).toEqual([{ t: 3, x: 0.5, y: 0.5 }]);
    expect(p.audio).toEqual([{ src: "voice/x.mp3", start: 5.5, duration: 2, volume: 1 }]);
    expect(p.texts.find((t) => t.style === "subtitle")).toMatchObject({ start: 5.5, end: 7.5, text: "مرحبا" });
    expect(p.camera[0]).toMatchObject({ t: 2.4, scale: 2 });
  });

  it("cross-fades the outro over the end of the video", () => {
    const outro = plan().cards[1]!;
    expect(outro).toMatchObject({ start: 11.5, dur: 2.5, fadeIn: 0.5 });
  });

  it("raises a bottom caption that would collide with a subtitle", () => {
    const html = renderHtml(plan(), { gsapSrc: "gsap.min.js" });
    expect(html).toMatch(/class="clip text pill pos-bottom-raised"[^>]*>.*Bottom pill/);
  });
});

describe("renderHtml", () => {
  const html = renderHtml(plan(), { gsapSrc: "gsap.min.js" });

  it("times only the video, not its wrapper", () => {
    expect(html).toContain('<div id="frame">');
    expect(html).toMatch(/<video id="rec" class="clip" data-start="2" data-duration="10" src="edited.mp4" muted/);
  });

  it("escapes user text and marks it bidi-aware", () => {
    expect(html).toContain("Hello &lt;World&gt;");
    expect(html).toContain('<span dir="auto">مرحبا</span>');
  });

  it("registers one paused root timeline", () => {
    expect(html).toContain("gsap.timeline({ paused: true })");
    expect(html).toContain('window.__timelines["main"] = tl;');
  });

  it("puts callouts below the point when it is near the top", () => {
    expect(html).toMatch(/class="clip callout below"/);
  });

  it("is deterministic", () => {
    expect(html).not.toMatch(/Math\.random|Date\.now/);
    expect(renderHtml(plan(), { gsapSrc: "gsap.min.js" })).toBe(html);
  });
});

describe("styling chosen by the agent", () => {
  const styled = (theme: Record<string, unknown>, captions: unknown[] = []) => {
    const s = StoryboardSchema.parse({ source: "rec.mp4", theme, captions });
    const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 10, offset: 0 });
    return renderHtml(
      buildPlan({ sb: s, timeline, editedSrc: "e.mp4", editedHasAudio: false, source: { width: 1920, height: 1080 }, narration: [], clicks: [] }),
      { gsapSrc: "g.js" },
    );
  };

  it("loads the storyboard's fonts and applies its CSS after the built-in styles", () => {
    const html = styled({ fonts: ["Tajawal:wght@400;700", "Space Grotesk:wght@500"], css: ".text.pill > span { border-radius: 0; }" });
    expect(html).toContain("family=Tajawal:wght@400;700");
    expect(html).toContain("family=Space+Grotesk:wght@500");
    expect(html.indexOf('<style id="theme-css">')).toBeGreaterThan(html.indexOf(".card p {"));
    expect(html).toContain(".text.pill > span { border-radius: 0; }");
  });

  it("can't break out of its style element", () => {
    const html = styled({ css: "x{}</style><script>alert(1)</script>" });
    expect(html).not.toContain("</style><script>");
  });

  it("adds nothing when no CSS is given", () => {
    expect(styled({})).not.toContain("theme-css");
  });

  it("splits a caption into lines with their own direction", () => {
    const html = styled({}, [{ at: 0, text: "Hello\nمرحبا" }]);
    expect(html).toContain('<span class="ln" dir="auto">Hello</span><span class="ln" dir="auto">مرحبا</span>');
  });
});
