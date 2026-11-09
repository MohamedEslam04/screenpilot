import { describe, expect, it } from "vitest";
import { busySpans } from "../src/render/chunks.js";
import { cardDirection, fitScale } from "../src/render/cards/index.js";
import { renderHtml } from "../src/render/html.js";
import { buildPlan } from "../src/render/plan.js";
import { windowPlan } from "../src/render/window.js";
import { lintStoryboard, parseStoryboard } from "../src/storyboard/load.js";
import { StoryboardSchema, storyboardJsonSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const list = {
  kind: "card",
  id: "why",
  template: "list",
  at: 2,
  dur: 4,
  data: {
    kicker: "الفوائد",
    title: "ليه تستخدم ScreenPilot؟",
    items: [
      { heading: "سريع", text: "بتطلع فيديو جاهز من تسجيل الشاشة في دقايق من غير مونتاج يدوي ولا برامج تانية." },
      { heading: "بالعربي", text: "الصوت والنص من اليمين للشمال من غير ما تعمل أي حاجة زيادة." },
    ],
    footer: "جرّب دلوقتي",
  },
};

const parse = (overlays: unknown[]) => parseStoryboard({ source: "r.mp4", overlays });

describe("card overlays in the schema", () => {
  it("keeps a media overlay without kind working", () => {
    const r = parse([{ src: "logo.png", x: 0, y: 0, w: 0.1, h: 0.1 }]);
    expect(r.ok).toBe(true);
  });

  it("accepts the four templates and keeps data and id as plain JSON", () => {
    const r = parse([
      list,
      { kind: "card", template: "flow", at: 6, dur: 3, data: { title: "Pipeline", steps: [{ label: "Record" }, { label: "Edit", text: "Cuts and zooms" }] } },
      { kind: "card", template: "number", at: 9, dur: 3, data: { value: 42, label: "videos" } },
      { kind: "card", template: "quote", at: 12, dur: 3, data: { text: "Fast.", author: "A. User" } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const card = r.sb.overlays[0]!;
    expect(card).toMatchObject({ kind: "card", id: "why", template: "list", at: 2, dur: 4 });
    expect(JSON.parse(JSON.stringify((card as { data: unknown }).data))).toEqual(list.data);
  });

  it("names the template when it is unknown", () => {
    const r = parse([{ kind: "card", template: "grid", at: 1, dur: 2, data: {} }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toMatch(/overlays\.0\.template.*list.*flow.*number.*quote/);
  });

  it("says what kind may be when it is wrong", () => {
    const r = parse([{ kind: "cardd", template: "list", at: 1, dur: 2, data: {} }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toContain('overlays.0.kind: kind must be "card"');
  });

  it("points at the missing field of the data", () => {
    const r = parse([{ kind: "card", template: "list", at: 1, dur: 2, data: { title: "T" } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toContain("overlays.0.data.items");
  });

  it("rejects a data key the template does not know, by name", () => {
    const r = parse([{ kind: "card", template: "list", at: 1, dur: 2, data: { items: [{ heading: "a" }], itemz: [] } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toMatch(/overlays\.0\.data.*itemz/);
  });

  it("needs at and dur, a heading per item and two steps for a flow", () => {
    expect(parse([{ kind: "card", template: "number", data: { value: "1" } }]).ok).toBe(false);
    const noHeading = parse([{ kind: "card", template: "list", at: 1, dur: 2, data: { items: [{ text: "x" }] } }]);
    expect(noHeading.ok).toBe(false);
    if (!noHeading.ok) expect(noHeading.issues.join("\n")).toContain("overlays.0.data.items.0.heading");
    const one = parse([{ kind: "card", template: "flow", at: 1, dur: 2, data: { steps: [{ label: "a" }] } }]);
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.issues.join("\n")).toContain("overlays.0.data.steps");
  });

  it("is in the JSON schema the agent reads", () => {
    const text = JSON.stringify(storyboardJsonSchema());
    expect(text).toContain('"card"');
    expect(text).toContain("quote");
    expect(text).toContain("Stable name");
  });

  it("warns about a repeated card id", () => {
    const r = parse([list, { ...list, at: 8 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(lintStoryboard(r.sb).join("\n")).toMatch(/overlays\[1\] repeats the card id "why" of overlays\[0\]/);
  });
});

function planOf(overlays: unknown[], opts: { segments?: unknown[]; intro?: number; voice?: unknown } = {}) {
  const sb = StoryboardSchema.parse({
    source: "r.mp4",
    intro: opts.intro ? { title: "Hi", dur: opts.intro } : undefined,
    segments: opts.segments ?? [],
    voice: opts.voice,
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
    overlays: overlays.map(() => undefined),
  });
}

describe("card overlays in the plan", () => {
  it("maps source time to output time through cuts and speed, and keeps media overlays apart", () => {
    const segments = [
      { in: 0, out: 4, speed: 1 },
      { in: 10, out: 20, speed: 2 },
    ];
    const p = planOf([{ ...list, at: 12, dur: 4 }], { segments });
    expect(p.overlays).toEqual([]);
    expect(p.dataCards).toHaveLength(1);
    expect(p.dataCards[0]).toMatchObject({ id: "why", template: "list", start: 5, end: 7, dir: "rtl", lang: "ar" });
  });

  it("shifts by the intro and drops a card whose start is cut out", () => {
    expect(planOf([list], { intro: 2 }).dataCards[0]).toMatchObject({ start: 4, end: 8 });
    const segments = [{ in: 0, out: 1, speed: 1 }];
    expect(planOf([list], { segments }).dataCards).toEqual([]);
  });

  it("has no data cards by default", () => {
    expect(planOf([]).dataCards).toEqual([]);
  });
});

describe("cardDirection", () => {
  it("follows the script of the text, not a hard-coded direction", () => {
    expect(cardDirection(["الفوائد", "سريع جدا"]).dir).toBe("rtl");
    expect(cardDirection(["Benefits", "Fast"]).dir).toBe("ltr");
    expect(cardDirection(["שלום", "עולם"])).toEqual({ dir: "rtl", lang: "he" });
    expect(cardDirection(["الفوائد", "API", "SDK", "الفوائد", "سريع"]).dir).toBe("rtl");
  });

  it("lets an explicit lang win, then falls back to the voice language for text without letters", () => {
    expect(cardDirection(["Benefits"], { lang: "ar" })).toEqual({ dir: "rtl", lang: "ar" });
    expect(cardDirection(["الفوائد"], { lang: "en" })).toEqual({ dir: "ltr", lang: "en" });
    expect(cardDirection(["42%"], { voiceLang: "ar" })).toEqual({ dir: "rtl", lang: "ar" });
    expect(cardDirection(["42%"])).toEqual({ dir: "ltr" });
  });
});

describe("fitScale", () => {
  it("shrinks long content until it fits and never goes under the floor", () => {
    const short = fitScale({ template: "quote", data: { text: "Fast." } }, { width: 1920, height: 1080 });
    const long = fitScale({ template: "quote", data: { text: "طويل ".repeat(200) } }, { width: 1920, height: 1080 });
    expect(short).toBe(1);
    expect(long).toBeLessThan(1);
    expect(long).toBeGreaterThanOrEqual(0.4);
  });
});

describe("card overlays in the html", () => {
  const plan = planOf([list]);
  const html = renderHtml(plan, { gsapSrc: "g.js" });

  it("draws the card with dir and lang from its text", () => {
    expect(html).toMatch(/<div id="dc0" class="clip dc dc-list" data-start="2" data-duration="4" dir="rtl" lang="ar"/);
    expect(html).toContain("ليه تستخدم ScreenPilot؟");
    expect(html).toContain("الفوائد");
  });

  it("wraps long items inside their box instead of overflowing it", () => {
    expect(html).toMatch(/\.dc \{[^}]*overflow: hidden/);
    expect(html).toMatch(/\.dc-item[^{]*\{[^}]*min-width: 0/);
    expect(html).toMatch(/overflow-wrap: anywhere/);
    expect(html).toMatch(/\.dc-box \{[^}]*max-width: /);
  });

  it("uses the theme colors and font, not fixed ones", () => {
    const themed = renderHtml({ ...plan, theme: { ...plan.theme, accent: "#ff00aa", captionColor: "#123456", font: "'Tajawal', sans-serif" } }, { gsapSrc: "g.js" });
    expect(themed).toMatch(/\.dc \{[^}]*font-family: 'Tajawal', sans-serif/);
    expect(themed).toContain("#ff00aa");
    expect(themed).toContain("#123456");
  });

  it("puts no direction marks into the text and never hard-codes a direction in css", () => {
    expect(html).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
    const start = html.indexOf('<style id="card-css">');
    const css = html.slice(start, html.indexOf("</style>", start));
    expect(css.length).toBeGreaterThan(100);
    expect(css).not.toMatch(/direction:\s*(rtl|ltr)/);
  });

  it("escapes markup in the data", () => {
    const evil = renderHtml(
      planOf([{ kind: "card", template: "quote", at: 1, dur: 2, data: { text: "<script>alert(1)</script>", author: "\"x\" & y" } }]),
      { gsapSrc: "g.js" },
    );
    expect(evil).not.toContain("<script>alert(1)");
    expect(evil).toContain("&lt;script&gt;alert(1)");
    expect(evil).toContain("&quot;x&quot; &amp; y");
  });

  it("is timed on the output and fades like an overlay by default", () => {
    expect(html).toContain('tl.fromTo("#dc0", { opacity: 0 }, { opacity: 1');
    expect(html.indexOf('id="dc0"')).toBeGreaterThan(html.indexOf('id="frame"'));
  });

  it("renders the other templates", () => {
    const others = renderHtml(
      planOf([
        { kind: "card", template: "flow", at: 1, dur: 2, data: { title: "Pipeline", steps: [{ label: "Record" }, { label: "Edit", text: "Cuts" }, { label: "Render" }] } },
        { kind: "card", template: "number", at: 4, dur: 2, data: { kicker: "Total", value: 1280, label: "videos", footer: "since June" } },
        { kind: "card", template: "quote", at: 7, dur: 2, data: { text: "Best tool.", author: "Sam", role: "Editor" } },
      ]),
      { gsapSrc: "g.js" },
    );
    expect(others).toMatch(/class="clip dc dc-flow"/);
    expect((others.match(/class="dc-step"/g) ?? []).length).toBe(3);
    expect((others.match(/class="dc-arrow"/g) ?? []).length).toBe(2);
    expect(others).toMatch(/class="clip dc dc-number"[\s\S]*class="dc-value"[^>]*>1280</);
    expect(others).toMatch(/class="clip dc dc-quote"[\s\S]*Best tool\.[\s\S]*Sam/);
  });

  it("leaves a storyboard without cards byte-identical (no card css or elements)", () => {
    const plain = renderHtml(planOf([]), { gsapSrc: "g.js" });
    expect(plain).not.toContain("dc-");
    expect(plain).not.toContain("dc0");
  });
});

describe("card overlays in windows and chunks", () => {
  const plan = planOf([{ ...list, at: 0, dur: 10 }]);

  it("clips to the window and skips the entrance and exit the window cut off", () => {
    const w = windowPlan(plan, { from: 3, to: 6 });
    expect(w.dataCards).toHaveLength(1);
    expect(w.dataCards[0]).toMatchObject({ start: 0, end: 3, motion: { in: "none", out: "none" } });
    expect(windowPlan(plan, { from: 11 }).dataCards).toEqual([]);
  });

  it("is a busy span at its entrance and exit, not in the middle of a long card", () => {
    const long = planOf([{ ...list, at: 0, dur: 20 }]);
    const busy = busySpans(long);
    expect(busy.some((s) => s.start <= 0 && s.end >= 3)).toBe(true);
    expect(busy.some((s) => s.start <= 10 && s.end >= 11)).toBe(false);
  });
});
