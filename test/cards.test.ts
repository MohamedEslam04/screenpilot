import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import { buildPlan } from "../src/render/plan.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline, planNarrationHolds } from "../src/storyboard/timeline.js";

describe("chapter cards in the schema", () => {
  it("defaults dur to 2.5 and keeps the subtitle optional", () => {
    const sb = StoryboardSchema.parse({ source: "r.mp4", cards: [{ at: 4, title: "Part 2" }] });
    expect(sb.cards).toEqual([{ at: 4, dur: 2.5, title: "Part 2" }]);
  });

  it("defaults to no cards and rejects a card without a title", () => {
    expect(StoryboardSchema.parse({ source: "r.mp4" }).cards).toEqual([]);
    expect(StoryboardSchema.safeParse({ source: "r.mp4", cards: [{ at: 1 }] }).success).toBe(false);
  });
});

describe("chapter cards in the timeline", () => {
  it("is a hold: later source times shift by the card length", () => {
    const tl = buildTimeline({ segments: [], holds: [{ at: 4, dur: 2.5, card: 0 }], sourceDuration: 10 });
    expect(tl.videoDuration).toBe(12.5);
    expect(tl.toOutput(3)).toBe(3);
    expect(tl.toOutput(6)).toBe(8.5);
    expect(tl.cardSpans()).toEqual([{ card: 0, start: 4, end: 6.5 }]);
  });

  it("adds the intro offset to the card span", () => {
    const tl = buildTimeline({ segments: [], holds: [{ at: 4, dur: 2, card: 1 }], sourceDuration: 10, offset: 3 });
    expect(tl.cardSpans()).toEqual([{ card: 1, start: 7, end: 9 }]);
  });

  it("reports a card whose time is cut out as ignored", () => {
    const tl = buildTimeline({ segments: [{ in: 0, out: 2, speed: 1 }], holds: [{ at: 5, dur: 2, card: 0 }], sourceDuration: 10 });
    expect(tl.cardSpans()).toEqual([]);
    expect(tl.ignoredHolds).toEqual([{ at: 5, dur: 2, card: 0 }]);
  });

  it("still lets narration auto-holds work around a card", () => {
    const holds = [{ at: 4, dur: 2.5, card: 0 }];
    const input = { segments: [], holds, sourceDuration: 10 };
    const added = planNarrationHolds({
      ...input,
      gap: 0.3,
      lines: [
        { at: 2, duration: 3 },
        { at: 3, duration: 1 },
      ],
    });
    const tl = buildTimeline({ ...input, holds: [...holds, ...added] });
    // second line is pushed to 5.3 (first ends at 5, plus the gap); the card start shifts with it
    expect(tl.toOutput(3)).toBeCloseTo(5.3, 3);
    expect(tl.cardSpans()[0]!.start).toBeCloseTo(4 + 2.3, 3);
  });
});

describe("chapter cards in the plan and html", () => {
  const sb = StoryboardSchema.parse({
    source: "r.mp4",
    intro: { title: "Intro", dur: 2 },
    outro: { title: "Bye", dur: 2 },
    cards: [{ at: 4, dur: 2.5, title: "Part <2>", subtitle: "Sub" }],
  });
  const holds = [{ at: 4, dur: 2.5, card: 0 }];
  const timeline = buildTimeline({ segments: [], holds, sourceDuration: 10, offset: 2 });
  const plan = buildPlan({
    sb,
    timeline,
    editedSrc: "e.mp4",
    editedHasAudio: false,
    source: { width: 1920, height: 1080 },
    narration: [],
    clicks: [],
  });

  it("puts the card between intro and outro, in output seconds, with cross-fades", () => {
    expect(plan.cards.map((c) => c.title)).toEqual(["Intro", "Part <2>", "Bye"]);
    expect(plan.cards[1]).toMatchObject({ start: 6, dur: 2.5, fadeIn: 0.3, fadeOut: 0.3, subtitle: "Sub" });
    expect(plan.duration).toBe(2 + 12.5 + 2);
  });

  it("renders it like the other cards, fading in and out", () => {
    const html = renderHtml(plan, { gsapSrc: "g.js" });
    expect(html).toMatch(/<div id="card1" class="clip card" data-start="6" data-duration="2.5">/);
    expect(html).toContain("Part &lt;2&gt;");
    expect(html).toContain('tl.fromTo("#card1", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 6);');
    expect(html).toContain('tl.to("#card1", { opacity: 0, duration: 0.3 }, 8.2);');
  });

  it("shrinks the fades for a very short card", () => {
    const short = buildTimeline({ segments: [], holds: [{ at: 4, dur: 0.6, card: 0 }], sourceDuration: 10 });
    const p = buildPlan({
      sb: { ...sb, intro: undefined, outro: undefined },
      timeline: short,
      editedSrc: "e.mp4",
      editedHasAudio: false,
      source: { width: 1920, height: 1080 },
      narration: [],
      clicks: [],
    });
    expect(p.cards[0]).toMatchObject({ fadeIn: 0.2, fadeOut: 0.2 });
  });
});
