import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHtml } from "../src/render/html.js";
import { buildPlan } from "../src/render/plan.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

// Real layout of the card templates in headless Chrome (the engine HyperFrames renders with), at the three
// output shapes. It measures boxes instead of comparing pixels: a golden image would depend on the fonts of
// the machine (Cairo comes from Google Fonts at render time), a measurement does not. Skipped when no Chrome
// is installed. Set CARD_SHOTS=<dir> to also write a PNG per case for a look by eye.

const SIZES = [
  { name: "16x9", width: 1920, height: 1080 },
  { name: "9x16", width: 1080, height: 1920 },
  { name: "1x1", width: 1080, height: 1080 },
];

const LONG_AR = "بتطلع فيديو جاهز من تسجيل الشاشة في دقايق من غير مونتاج يدوي ولا برامج تانية، والصوت والنص بيتظبطوا لوحدهم من اليمين للشمال.";
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ heading: `الميزة رقم ${i + 1} في المنتج الجديد`, text: LONG_AR }));

const CASES: { name: string; data: Record<string, unknown>; template: string }[] = [
  { name: "list-ar-6-long", template: "list", data: { kicker: "الفوائد", title: "ليه تستخدم ScreenPilot لعمل الفيديوهات؟", items: items(6), footer: "جرّب دلوقتي من غير ما تدفع حاجة" } },
  { name: "list-ar-3-short", template: "list", data: { title: "ثلاث خطوات", items: [{ heading: "سجّل" }, { heading: "عدّل", text: "قصّ وكبّر" }, { heading: "صدّر" }] } },
  { name: "list-ar-mixed-latin", template: "list", data: { title: "مكونات API Gateway", items: [{ heading: "Rate limiting", text: "حد الطلبات لكل مفتاح API في الدقيقة، ويرجع 429 لما يعدي الحد." }, { heading: "https://example.com/very/long/path/with/no/spaces/at/all/that/keeps/going/and/going/forever/and/ever", text: "رابط طويل من غير مسافات" }] } },
  { name: "list-en-8", template: "list", data: { kicker: "WHY", title: "Everything you need to ship a demo", items: items(8).map((i) => ({ heading: "Feature heading that is a bit long", text: "A longer explanation of the feature that has to wrap inside its own box without leaving it, even in a narrow frame." })) } },
  { name: "flow-ar-4", template: "flow", data: { title: "من التسجيل للفيديو", steps: [{ label: "تسجيل الشاشة", text: LONG_AR.slice(0, 60) }, { label: "تحليل", text: "بنلاقي الوقت الضايع" }, { label: "تعديل الـ storyboard" }, { label: "تصدير الفيديو النهائي بصيغة MP4" }] } },
  { name: "flow-ar-7", template: "flow", data: { title: "رحلة كاملة", steps: Array.from({ length: 7 }, (_, i) => ({ label: `الخطوة ${i + 1}: تجهيز الملفات`, text: LONG_AR.slice(0, 70) })) } },
  { name: "number-ar", template: "number", data: { kicker: "الإجمالي", value: "٩٨٫٦ مليون", label: "دقيقة فيديو اتعملت بالأداة من أول السنة", footer: "حسب آخر تحديث" } },
  { name: "number-en-short", template: "number", data: { value: 42, label: "videos" } },
  { name: "quote-ar-long", template: "quote", data: { kicker: "رأي العميل", text: `${LONG_AR} ${LONG_AR} ${LONG_AR}`, author: "محمد عبد الله", role: "مدير المنتج في شركة تجريبية" } },
  { name: "quote-en", template: "quote", data: { text: "The fastest way I found to turn a screen recording into a demo.", author: "A. User" } },
];

function chromePath(): string | undefined {
  const candidates = [process.env.SCREENPILOT_TEST_CHROME, safe(() => chromium.executablePath())].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(c));
}
const safe = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

const chrome = chromePath() ?? undefined;
const shots = process.env.CARD_SHOTS;

function htmlFor(c: (typeof CASES)[number], size: { width: number; height: number }): string {
  const sb = StoryboardSchema.parse({ source: "r.mp4", output: size, overlays: [{ kind: "card", template: c.template, at: 0, dur: 5, data: c.data }] });
  const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 10 });
  const plan = buildPlan({ sb, timeline, editedSrc: "e.mp4", editedHasAudio: false, source: { width: 1920, height: 1080 }, narration: [], clicks: [], overlays: [undefined] });
  return renderHtml({ ...plan, width: size.width, height: size.height }, { gsapSrc: "missing-gsap.js" });
}

describe.skipIf(!chrome)("card layout in a real browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    if (shots) mkdirSync(shots, { recursive: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const size of SIZES) {
    for (const c of CASES) {
      it(`${c.name} at ${size.name} stays inside the frame, wraps inside its boxes and is right-to-left when Arabic`, async () => {
        const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
        try {
          await page.route(/^https?:/, (r) => r.abort());
          await page.setContent(htmlFor(c, size), { waitUntil: "domcontentloaded" });
          await page.evaluate(() => document.fonts.ready);
          if (shots) writeFileSync(join(shots, `${c.name}-${size.name}.png`), await page.screenshot());
          const result = await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(".dc")!;
            const W = innerWidth;
            const H = innerHeight;
            const cs = getComputedStyle(root);
            const padX = parseFloat(cs.paddingLeft);
            const padY = parseFloat(cs.paddingTop);
            const bad: string[] = [];
            const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className}`;
            for (const el of root.querySelectorAll("*")) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              if (r.left < padX - 1 || r.right > W - padX + 1 || r.top < padY - 1 || r.bottom > H - padY + 1) bad.push(`${name(el)} leaves the card area: ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${W}x${H}`);
            }
            for (const panel of root.querySelectorAll(".dc-item, .dc-step")) {
              const p = panel.getBoundingClientRect();
              for (const el of panel.querySelectorAll("*")) {
                const r = el.getBoundingClientRect();
                if (r.left < p.left - 1 || r.right > p.right + 1 || r.bottom > p.bottom + 1) bad.push(`${name(el)} spills out of its ${name(panel)}`);
              }
            }
            for (const el of root.querySelectorAll("*")) if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline") bad.push(`${name(el)} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
            return { bad, dir: root.getAttribute("dir"), lang: root.getAttribute("lang"), computedDir: cs.direction, fs: cs.getPropertyValue("--fs") };
          });
          expect(result.bad).toEqual([]);
          if (c.name.includes("-ar")) {
            expect(result).toMatchObject({ dir: "rtl", lang: "ar", computedDir: "rtl" });
          } else {
            expect(result.dir).toBe("ltr");
          }
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }

  it("puts the first item at the right edge for Arabic and at the left edge for English", async () => {
    const edge = async (c: (typeof CASES)[number]) => {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await page.route(/^https?:/, (r) => r.abort());
        await page.setContent(htmlFor(c, { width: 1920, height: 1080 }), { waitUntil: "domcontentloaded" });
        return await page.evaluate(() => {
          const mark = document.querySelector(".dc-mark")!.getBoundingClientRect();
          const item = document.querySelector(".dc-item")!.getBoundingClientRect();
          return { markNearRight: item.right - mark.right < mark.left - item.left };
        });
      } finally {
        await page.close();
      }
    };
    expect((await edge(CASES.find((c) => c.name === "list-ar-3-short")!)).markNearRight).toBe(true);
    expect((await edge({ name: "en", template: "list", data: { items: [{ heading: "One" }, { heading: "Two" }] } })).markNearRight).toBe(false);
  });
});
