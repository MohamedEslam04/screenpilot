import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import { planChunks } from "../src/render/chunks.js";
import { buildPlan } from "../src/render/plan.js";
import { pressFor, typingPresses } from "../src/render/typing.js";
import { windowPlan } from "../src/render/window.js";
import { lintStyle } from "../src/storyboard/lint.js";
import { AnnotationSchema, StoryboardSchema, ThemeSchema, TypingSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const pt = (x: number, y: number) => ({ x, y });
const arrow = { type: "arrow", at: 2, from: pt(0.1, 0.5), to: pt(0.5, 0.5) };
const box = { type: "box", at: 3, dur: 2, x: 0.2, y: 0.2, w: 0.3, h: 0.1 };
const blur = { type: "blur", at: 4, dur: 2, x: 0.6, y: 0.1, w: 0.2, h: 0.05 };

function sbOf(extra: Record<string, unknown>) {
  return StoryboardSchema.parse({ source: "r.mp4", ...extra });
}

function planOf(extra: Record<string, unknown>, segments: { in: number; out: number }[] = []) {
  const sb = sbOf({ segments: segments.map((s) => ({ ...s, speed: 1 })), ...extra });
  const timeline = buildTimeline({ segments: sb.segments, holds: [], sourceDuration: 20, offset: sb.intro?.dur ?? 0 });
  return buildPlan({ sb, timeline, editedSrc: "e.mp4", editedHasAudio: false, source: { width: 1920, height: 1080 }, narration: [], clicks: [] });
}

const html = (extra: Record<string, unknown>) => renderHtml(planOf(extra), { gsapSrc: "g.js" });

describe("annotations in the schema", () => {
  const parse = (a: unknown) => StoryboardSchema.safeParse({ source: "r.mp4", annotations: [a] });

  it("defaults to none and applies the defaults of each type", () => {
    expect(sbOf({}).annotations).toEqual([]);
    expect(AnnotationSchema.parse(arrow)).toMatchObject({ type: "arrow", dur: 3, width: 8 });
    expect(AnnotationSchema.parse(box)).toMatchObject({ type: "box", shape: "box" });
    expect(AnnotationSchema.parse(blur)).toMatchObject({ type: "blur", mode: "blur", strength: 18 });
  });

  it("rejects what cannot be drawn", () => {
    expect(parse({ type: "arrow", at: 1, from: pt(0.1, 0.1) }).success).toBe(false);
    expect(parse({ ...arrow, to: pt(1.2, 0.5) }).success).toBe(false);
    expect(parse({ ...arrow, width: 40 }).success).toBe(false);
    expect(parse({ ...blur, w: 0 }).success).toBe(false);
    expect(parse({ ...blur, strength: 1 }).success).toBe(false);
    expect(parse({ ...blur, mode: "pixelate" }).success).toBe(false);
    expect(parse({ ...box, shape: "star" }).success).toBe(false);
    expect(parse({ type: "spiral", at: 1 }).success).toBe(false);
  });

  it("accepts labels, colors, ellipses and solid redaction", () => {
    expect(parse({ ...arrow, label: "Click here", color: "#ff0066", width: 12 }).success).toBe(true);
    expect(parse({ ...box, shape: "ellipse", label: "Total", motion: { in: "pop" } }).success).toBe(true);
    expect(parse({ ...blur, mode: "solid", color: "#111111" }).success).toBe(true);
  });

  it("takes keycaps on a typing span", () => {
    expect(TypingSchema.parse({ at: 1, text: "hi", keycaps: true })).toEqual({ at: 1, dur: 3, text: "hi", keycaps: true });
  });
});

describe("annotations in the plan", () => {
  it("maps source times to output times through the cuts and drops the ones that are cut", () => {
    const p = planOf({ annotations: [{ ...box, at: 7 }, { ...box, at: 1 }] }, [{ in: 5, out: 15 }]);
    expect(p.annotations).toHaveLength(1);
    expect(p.annotations[0]).toMatchObject({ kind: "box", start: 2, end: 4, x: 0.2, w: 0.3, shape: "box" });
  });

  it("uses the theme accent unless a color is given, and black for solid redaction", () => {
    const p = planOf({ theme: { accent: "#00ff00" }, annotations: [arrow, { ...box, color: "#123456" }, { ...blur, mode: "solid" }] });
    expect(p.annotations.map((a) => ("color" in a ? a.color : undefined))).toEqual(["#00ff00", "#123456", "#0b0b0b"]);
  });

  it("has no annotations for a storyboard that has none", () => {
    expect(planOf({}).annotations).toEqual([]);
    expect(planOf({}).keys).toEqual([]);
  });
});

describe("annotations in the page", () => {
  it("draws an arrow in camera space: a shaft that draws on, a head, a label", () => {
    const p = planOf({ annotations: [{ ...arrow, label: "Look <here>", color: '#f06"' }] });
    const out = renderHtml(p, { gsapSrc: "g.js" });
    expect(out).toContain('class="clip ann ann-arrow"');
    expect(out).toContain("<polygon");
    expect(out).toContain('class="shaft"');
    expect(out).toContain("stroke-dasharray");
    expect(out).toContain("Look &lt;here&gt;");
    expect(out).not.toContain('#f06"');
    const w = p.cam.w;
    const h = p.cam.h;
    expect(out).toContain(`x1="${Math.round(0.1 * w * 1000) / 1000}"`);
    expect(out).toContain(`y1="${Math.round(0.5 * h * 1000) / 1000}"`);
    expect(out).toContain('tl.fromTo("#an0 .shaft"');
    expect(out).toContain('tl.fromTo("#an0 .head"');
  });

  it("puts the head of an arrow on the tip, not past it", () => {
    const p = planOf({ annotations: [{ ...arrow, from: pt(0.1, 0.5), to: pt(0.5, 0.5) }] });
    const out = renderHtml(p, { gsapSrc: "g.js" });
    const m = /<polygon[^>]*points="([^"]+)"/.exec(out)!;
    const xs = m[1]!.split(" ").map((pair) => Number(pair.split(",")[0]));
    expect(Math.max(...xs)).toBeCloseTo(0.5 * p.cam.w, 1);
  });

  it("draws a box and an ellipse with an optional label", () => {
    const b = html({ annotations: [{ ...box, label: "Total" }] });
    expect(b).toContain('class="clip ann ann-box"');
    expect(b).toContain(">Total<");
    expect(b).not.toContain("border-radius:50%");
    expect(html({ annotations: [{ ...box, shape: "ellipse" }] })).toContain("border-radius:50%");
  });

  it("covers the region with a blur or a solid fill, shown at once with no fade", () => {
    const b = html({ annotations: [blur] });
    expect(b).toContain('class="clip ann ann-blur"');
    expect(b).toContain("backdrop-filter:blur(18px)");
    expect(b).not.toContain('"#an0"');
    const s = html({ annotations: [{ ...blur, mode: "solid", color: "#111111" }] });
    expect(s).toContain("background:#111111");
    expect(s).not.toContain("backdrop-filter");
    expect(s).not.toContain('"#an0"');
  });

  it("numbers annotations in plan order", () => {
    const out = html({ annotations: [arrow, box, blur] });
    expect(out).toContain('id="an0"');
    expect(out).toContain('id="an1"');
    expect(out).toContain('id="an2"');
  });

  it("lists the classes for theme.css", () => {
    expect(ThemeSchema.shape.css.description).toMatch(/\.ann-arrow.*\.ann-box.*\.ann-blur.*\.keys/);
  });
});

describe("annotations in a partial render", () => {
  const p = planOf({ annotations: [{ ...box, at: 2, dur: 4 }] });

  it("trims them to the window and settles one that started before it", () => {
    const w = windowPlan(p, { from: 3, to: 5 });
    expect(w.annotations).toHaveLength(1);
    expect(w.annotations[0]).toMatchObject({ start: 0, end: 2, settled: true });
  });

  it("keeps the entrance when the window starts before it", () => {
    const w = windowPlan(p, { from: 1, to: 4 });
    expect(w.annotations[0]).toMatchObject({ start: 1, end: 3 });
    expect(w.annotations[0]).not.toHaveProperty("settled");
  });

  it("drops the ones outside the window", () => {
    expect(windowPlan(p, { from: 8, to: 10 }).annotations).toEqual([]);
  });
});

describe("keycaps", () => {
  const typing = { at: 2, dur: 2, text: "hi there", keycaps: true };

  it("reveals each word on the press that finishes it, the same presses that make the typing sound", () => {
    const p = planOf({ typing: [typing] });
    const presses = typingPresses({ at: 2, dur: 2, text: "hi there" }, 0);
    expect(p.keys).toHaveLength(1);
    expect(p.keys[0]!.words).toEqual([
      { text: "hi", at: presses[1] },
      { text: "there", at: presses[7] },
    ]);
    expect(p.keys[0]!.start).toBe(2);
    expect(p.keys[0]!.end).toBeCloseTo(presses[7]! + 0.8, 3);
  });

  it("is off without keycaps or without text", () => {
    expect(planOf({ typing: [{ ...typing, keycaps: false }] }).keys).toEqual([]);
    expect(planOf({ typing: [{ at: 2, dur: 2, keycaps: true }] }).keys).toEqual([]);
  });

  it("skips a text with no words at all instead of failing the render", () => {
    expect(planOf({ typing: [{ at: 2, dur: 2, text: "   ", keycaps: true }] }).keys).toEqual([]);
    expect(planOf({ typing: [{ at: 2, dur: 2, text: "\n\t", keycaps: true }] }).keys).toEqual([]);
  });

  it("keeps every word on its own press in a very long text (over 400 characters)", () => {
    const text = "w ".repeat(400).trim();
    const p = planOf({ typing: [{ at: 1, dur: 15, text, keycaps: true }] });
    const times = p.keys[0]!.words.map((w) => w.at);
    expect(times).toHaveLength(400);
    expect(new Set(times).size).toBe(400);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("follows the cuts: a span cut out entirely is dropped", () => {
    expect(planOf({ typing: [typing] }, [{ in: 10, out: 20 }]).keys).toEqual([]);
  });

  it("is drawn on the stage with one tween per word", () => {
    const p = planOf({ typing: [typing] });
    const out = renderHtml(p, { gsapSrc: "g.js" });
    expect(out).toContain('class="clip keys"');
    expect(out).toContain('<span class="w">hi</span>');
    expect(out).toContain('<span class="w">there</span>');
    expect(out.match(/tl\.fromTo\("#ky0 \.w:nth-child/g)).toHaveLength(2);
  });

  it("shows the words already typed when a partial render starts in the middle", () => {
    const p = planOf({ typing: [typing] });
    const at = p.keys[0]!.words[1]!.at;
    const w = windowPlan(p, { from: at - 0.1, to: at + 1 });
    expect(w.keys[0]!.words[0]!.at).toBe(0);
    expect(w.keys[0]!.words[1]!.at).toBeCloseTo(0.1, 3);
  });
});

describe("pressFor", () => {
  it("is the character index itself when every character has a press", () => {
    for (const i of [0, 1, 7, 19]) expect(pressFor(i, 20, 20)).toBe(i);
  });

  it("spreads the characters over fewer presses and never goes past the last one", () => {
    expect(pressFor(0, 800, 400)).toBe(0);
    expect(pressFor(399, 800, 400)).toBe(199);
    expect(pressFor(799, 800, 400)).toBe(399);
    expect(pressFor(5000, 800, 400)).toBe(399);
  });
});

describe("lint for annotations", () => {
  it("warns about a tiny blur, a zero-length arrow and keycaps without text", () => {
    const sb = sbOf({
      annotations: [
        { ...blur, w: 0.01, h: 0.01 },
        { ...arrow, from: pt(0.3, 0.3), to: pt(0.3, 0.3) },
      ],
      typing: [{ at: 1, dur: 2, keycaps: true }],
    });
    const out = lintStyle(sb);
    expect(out.some((m) => /annotations\[0\].*blur.*small/.test(m))).toBe(true);
    expect(out.some((m) => /annotations\[1\].*arrow.*no length/.test(m))).toBe(true);
    expect(out.some((m) => /typing\[0\].*keycaps.*text/.test(m))).toBe(true);
    expect(lintStyle(sbOf({ typing: [{ at: 1, dur: 2, text: "  ", keycaps: true }] })).some((m) => /typing\[0\].*keycaps.*text/.test(m))).toBe(true);
  });

  it("is quiet for sensible annotations", () => {
    expect(lintStyle(sbOf({ annotations: [arrow, box, blur], typing: [{ at: 1, dur: 2, text: "hi", keycaps: true }] }))).toEqual([]);
  });
});

// Privacy: a blur that hides a secret must show for every part of its range that lies in kept footage.
describe("annotations that overlap cuts, speed changes and long ranges", () => {
  const secret = { type: "blur", mode: "solid", x: 0.1, y: 0.1, w: 0.3, h: 0.05 };
  const seg = (inn: number, out: number, speed = 1, extra: Record<string, unknown> = {}) => ({ in: inn, out, speed, ...extra });
  function plan(segments: ReturnType<typeof seg>[], annotations: object[], extra: Record<string, unknown> = {}, sourceDuration = 600) {
    const sb = sbOf({ segments, annotations, ...extra });
    const timeline = buildTimeline({ segments: sb.segments, holds: sb.holds, sourceDuration, offset: sb.intro?.dur ?? 0 });
    return buildPlan({ sb, timeline, editedSrc: "e.mp4", editedHasAudio: false, source: { width: 1920, height: 1080 }, narration: [], clicks: [] });
  }
  const spans = (p: ReturnType<typeof plan>) => p.annotations.map((a) => [a.start, a.end]);

  it("(a) keeps an annotation longer than 8 s for its whole range", () => {
    const p = plan([seg(0, 40)], [{ ...secret, at: 2, dur: 12 }]);
    expect(spans(p)).toEqual([[2, 14]]);
  });

  it("(b) shows the part of an annotation that starts before segments[0].in but runs into kept footage", () => {
    const p = plan([seg(6, 30)], [{ ...secret, at: 0, dur: 10 }]);
    expect(spans(p)).toEqual([[0, 4]]);
  });

  it("(c) shows the kept part of an annotation that starts inside a cut gap", () => {
    const p = plan([seg(0, 5), seg(8, 20)], [{ ...secret, at: 6, dur: 4 }]);
    // source 8..10 is output 5..7
    expect(spans(p)).toEqual([[5, 7]]);
  });

  it("(c) ends an annotation where the footage ends when its end falls in a cut gap", () => {
    const p = plan([seg(0, 10), seg(15, 25)], [{ ...secret, at: 5, dur: 8 }]);
    // source 5..10 is output 5..10; 10..13 is cut. Not 5..13 (that would hide the footage after the cut).
    expect(spans(p)).toEqual([[5, 10]]);
  });

  it("(c) splits an annotation in several pieces when a hold falls in the middle of a cut", () => {
    const p = plan([seg(0, 4), seg(8, 12)], [{ ...secret, at: 2, dur: 8 }], { holds: [{ at: 3, dur: 2 }] });
    // source 2..3 -> output 2..3, hold 3..5, source 3..4 -> 5..6, cut, source 8..10 -> 6..8: one contiguous piece 2..8
    expect(spans(p)).toEqual([[2, 8]]);
  });

  it("(d) maps through a speed change", () => {
    const p = plan([seg(0, 10), seg(10, 20, 2)], [{ ...secret, at: 8, dur: 6 }], { zooms: [{ at: 9, dur: 3, x: 0.5, y: 0.5, scale: 2 }] });
    // source 8..10 at 1x = 2 s, source 10..14 at 2x = 2 s
    expect(spans(p)).toEqual([[8, 12]]);
  });

  it("(d) maps through a speed ramp", () => {
    const p = plan([seg(0, 10, 1, { speedTo: 4 })], [{ ...secret, at: 0, dur: 10 }]);
    expect(p.annotations).toHaveLength(1);
    expect(p.annotations[0]!.start).toBe(0);
    expect(p.annotations[0]!.end).toBeCloseTo(p.video.duration, 2);
  });

  it("(d) keeps a blur over a hold (the frozen frame still shows the secret)", () => {
    const p = plan([seg(0, 10)], [{ ...secret, at: 2, dur: 4 }], { holds: [{ at: 4, dur: 3 }] });
    expect(spans(p)).toEqual([[2, 9]]);
  });

  it("drops an annotation that is entirely in cut footage", () => {
    expect(plan([seg(10, 20)], [{ ...secret, at: 1, dur: 5 }]).annotations).toEqual([]);
  });

  it("adds the intro offset", () => {
    const p = plan([seg(6, 30)], [{ ...secret, at: 0, dur: 10 }], { intro: { title: "Hi", dur: 2 } });
    expect(spans(p)).toEqual([[2, 6]]);
  });

  it("(e) a partial render keeps the part of the blur inside the window", () => {
    const full = plan([seg(0, 5), seg(8, 40)], [{ ...secret, at: 6, dur: 20 }]);
    expect(spans(full)).toEqual([[5, 23]]);
    const w = windowPlan(full, { from: 10, to: 15 });
    expect(w.annotations.map((a) => [a.start, a.end])).toEqual([[0, 5]]);
    const head = windowPlan(full, { from: 2, to: 8 });
    expect(head.annotations.map((a) => [a.start, a.end])).toEqual([[3, 6]]);
  });

  it("(e) every chunk of a 6 minute render shows the blur wherever the full video does", () => {
    const full = plan([seg(20, 200), seg(230, 400)], [{ ...secret, at: 5, dur: 300 }, { ...secret, at: 150, dur: 100 }], {}, 600);
    expect(full.duration).toBeGreaterThanOrEqual(300);
    const chunks = planChunks(full, { target: 100, min: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    const at = (items: { start: number; end: number }[], t: number) => items.some((a) => a.start <= t && t < a.end);
    for (const c of chunks) {
      const win = windowPlan(full, { from: c.start, to: c.end });
      for (let t = c.start + 0.25; t < c.end; t += 0.5) {
        expect(at(win.annotations, t - c.start), `t=${t}`).toBe(at(full.annotations, t));
      }
    }
    // blur 1 is source 5..305: kept 20..200 and 230..305 = output 0..255 (the cut collapses); blur 2 ends inside it
    expect(at(full.annotations, 0)).toBe(true);
    expect(at(full.annotations, 254)).toBe(true);
    expect(at(full.annotations, 256)).toBe(false);
  });
});
