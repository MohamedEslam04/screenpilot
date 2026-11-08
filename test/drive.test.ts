import { afterAll, describe, expect, it } from "vitest";
import { describeError, TargetError } from "../src/drive/errors.js";
import { mapStreams } from "../src/drive/index.js";
import { charKeysym, parseCombo, splitTyping } from "../src/drive/keys.js";
import { parseStreams } from "../src/drive/portal.js";
import { mapSources } from "../src/drive/see.js";
import { chromium } from "playwright-core";
import { TakeSchema } from "../src/take/schema.js";
import { contentToScreen, describeCover, findCover } from "../src/drive/web.js";

const screens = [
  { name: "eDP-1", x: 1920, y: 0, w: 1920, h: 1080, model: "32429" },
  { name: "HDMI-A-5", x: 0, y: 0, w: 1920, h: 1080, model: "R24e" },
];

describe("keys", () => {
  it("maps printable Latin-1 and control characters", () => {
    expect(charKeysym("a")).toBe(0x61);
    expect(charKeysym("A")).toBe(0x41);
    expect(charKeysym("\n")).toBe(0xff0d);
    expect(charKeysym("م")).toBeNull();
  });

  it("parses combos", () => {
    expect(parseCombo("ctrl+shift+T")).toEqual([0xffe3, 0xffe1, 0x74]);
    expect(parseCombo("F5")).toEqual([0xffc2]);
    expect(() => parseCombo("ctrl+nope")).toThrow(/nope/);
  });

  it("splits text into key runs and clipboard runs", () => {
    expect(splitTyping("Hi مرحبا!")).toEqual([
      { keys: true, text: "Hi " },
      { keys: false, text: "مرحبا" },
      { keys: true, text: "!" },
    ]);
  });
});

describe("portal streams", () => {
  it("parses Start's streams", () => {
    const raw = [[144, { position: [1920, 0], size: [1920, 1080], source_type: 1 }]];
    expect(parseStreams(raw)).toEqual([{ node: 144, x: 1920, y: 0, w: 1920, h: 1080 }]);
  });

  it("maps streams to monitors by position", () => {
    const m = mapStreams(
      [
        { node: 144, x: 1920, y: 0, w: 1920, h: 1080 },
        { node: 119, x: 0, y: 0, w: 1920, h: 1080 },
      ],
      screens,
    );
    expect(m.get("eDP-1")?.node).toBe(144);
    expect(m.get("HDMI-A-5")?.node).toBe(119);
  });
});

describe("mapSources", () => {
  it("uses names, then elimination", () => {
    const m = mapSources(["Lenovo R24e | Monitor", "PC Screen"], screens);
    expect(m.get("HDMI-A-5")).toBe("Lenovo R24e | Monitor");
    expect(m.get("eDP-1")).toBe("PC Screen");
  });

  it("prefers a saved mapping", () => {
    const m = mapSources(["A", "B"], screens, { A: "eDP-1", B: "HDMI-A-5" });
    expect(m.get("eDP-1")).toBe("A");
    expect(m.get("HDMI-A-5")).toBe("B");
  });
});

describe("contentToScreen", () => {
  it("adds the window position and toolbar height", () => {
    const p = contentToScreen(
      { x: 100, y: 50, width: 20, height: 10 },
      { iw: 1000, ih: 700, ow: 1000, oh: 800 },
      { x: 500, y: 60, w: 1000, h: 800 },
    );
    // toolbar = 100px, so content starts at y=160
    expect(p).toEqual({ x: 610, y: 215, w: 20, h: 10 });
  });

  it("scales CSS px to logical px", () => {
    const p = contentToScreen(
      { x: 0, y: 0, width: 10, height: 10 },
      { iw: 2000, ih: 1400, ow: 2000, oh: 1600 },
      { x: 0, y: 0, w: 1000, h: 800 },
    );
    expect(p.w).toBe(5);
    expect(p.y).toBe(100 + 2.5);
  });
});

describe("charStroke", () => {
  it("presses Shift explicitly for capitals and shifted symbols", async () => {
    const { charStroke } = await import("../src/drive/keys.js");
    expect(charStroke("A")).toEqual({ sym: 0x61, shift: true });
    expect(charStroke("a")).toEqual({ sym: 0x61, shift: false });
    expect(charStroke("!")).toEqual({ sym: 0x31, shift: true });
    expect(charStroke("|")).toEqual({ sym: 0x5c, shift: true });
    expect(charStroke("1")).toEqual({ sym: 0x31, shift: false });
    expect(charStroke("\n")).toEqual({ sym: 0xff0d, shift: false });
    expect(charStroke("é")).toBeNull();
  });
});

describe("describeCover", () => {
  it("names the element on top: tag, id, classes and a bit of its text", () => {
    expect(describeCover({ tag: "div", id: "toolbar", cls: "sticky", text: "Filters" })).toBe('div#toolbar.sticky "Filters"');
    expect(describeCover({ tag: "header", id: "", cls: "nav fixed", text: "" })).toBe("header.nav.fixed");
  });

  it("says nothing is there when the point is outside the page", () => {
    expect(describeCover(null)).toBe("nothing (outside the page)");
  });
});

describe("TARGET_COVERED", () => {
  it("is a target error: nothing was sent, so retrying is safe", () => {
    const err = new TargetError("TARGET_COVERED", '"#go" is covered by div#bar');
    expect(describeError(err)).toEqual({ code: "TARGET_COVERED", delivery: "not_delivered", retry: "safe" });
  });
});

describe("click force", () => {
  const take = (step: unknown) => TakeSchema.safeParse({ steps: [step] });
  it("accepts force next to a web click", () => {
    expect(take({ click: { web: "#go" }, force: true }).success).toBe(true);
    expect(take({ click: { web: "#go" } }).success).toBe(true);
  });
  it("rejects a non-boolean force", () => {
    expect(take({ click: { web: "#go" }, force: "yes" }).success).toBe(false);
  });
});

// A real page in headless Chromium (no window, the desktop is untouched). Skipped where no browser is installed.
describe("findCover (headless Chromium)", async () => {
  const browser = await chromium.launch().catch(() => undefined);
  const html = `<style>body{margin:0}
    #go{position:absolute;left:100px;top:100px;width:100px;height:40px}
    #bar{position:fixed;left:0;top:90px;width:400px;height:60px;background:#ccc}
    #inner{display:block;width:100%;height:100%}</style>
    <button id="go"><span id="inner">Go</span></button><div id="bar" class="sticky">Filters</div>
    <button id="free" style="position:absolute;left:100px;top:300px;width:100px;height:40px">Free</button>`;
  afterAll(() => browser?.close());
  const run = async (fn: (page: import("playwright-core").Page) => Promise<void>) => {
    const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(html);
      await fn(page);
    } finally {
      await page.close();
    }
  };
  const centre = async (page: import("playwright-core").Page, sel: string) => {
    const b = (await page.locator(sel).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  it.skipIf(!browser)("reports the element that sits on top of the target", async () => {
    await run(async (page) => {
      const r = await findCover(page.locator("#go"), await centre(page, "#go"));
      expect(r.covered).toBe(true);
      expect(describeCover(r.hit)).toBe('div#bar.sticky "Filters"');
    });
  });

  it.skipIf(!browser)("an uncovered element, or its own child on top, is not covered", async () => {
    await run(async (page) => {
      expect((await findCover(page.locator("#free"), await centre(page, "#free"))).covered).toBe(false);
      await page.addStyleTag({ content: "#bar{display:none}" });
      expect((await findCover(page.locator("#go"), await centre(page, "#go"))).covered).toBe(false);
    });
  });

  it.skipIf(!browser)("a point outside the viewport is covered by nothing", async () => {
    await run(async (page) => {
      const r = await findCover(page.locator("#free"), { x: 5000, y: 5000 });
      expect(r).toEqual({ covered: true, hit: null });
    });
  });

  it.skipIf(!browser)("scrolling the element to the middle clears a sticky header that covered it", async () => {
    await run(async (page) => {
      await page.setContent(`<style>body{margin:0;height:3000px}
        #head{position:fixed;z-index:10;top:0;left:0;right:0;height:80px;background:#ccc}
        #go{position:absolute;top:1000px;left:100px;width:100px;height:40px}</style>
        <div id="head">Menu</div><button id="go">Go</button>`);
      const go = page.locator("#go");
      await page.evaluate(() => scrollTo(0, 990)); // the button's centre now sits under the header
      const centre = async () => {
        const b = (await go.boundingBox())!;
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      expect((await findCover(go, await centre())).covered).toBe(true);
      await go.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
      expect((await findCover(go, await centre())).covered).toBe(false);
    });
  });
});
