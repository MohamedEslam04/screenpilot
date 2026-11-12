import { afterAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { describeError, TargetError } from "../src/drive/errors.js";
import { DemoBrowser, findCover, stripAnsi } from "../src/drive/web.js";
import type { WindowInfo } from "../src/platform/index.js";

// Real pages in headless Chromium (no window, the desktop is untouched). Skipped where no browser is installed.
const browser = await chromium.launch().catch(() => undefined);
afterAll(() => browser?.close());

const win: WindowInfo = { id: "w", caption: "demo", resourceClass: "chrome", pid: 1, active: true, minimized: false, x: 0, y: 0, w: 800, h: 600, output: "eDP-1" } as WindowInfo;

async function withDemo<T>(html: string, fn: (b: DemoBrowser, page: Page) => Promise<T>): Promise<T> {
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(html);
    const fake = { isConnected: () => true, contexts: () => [{ pages: () => [page] }] } as unknown as Browser;
    const b = new DemoBrowser("main", { connect: async () => fake });
    vi.spyOn(b, "window").mockResolvedValue(win);
    // The calibration only needs the page to see the pointer move.
    const pointer = { moveToGlobal: async (to: { x: number; y: number }) => void (await page.mouse.move(Math.max(0, to.x), Math.max(0, to.y))) };
    return await fn(Object.assign(b, { pointer }), page);
  } finally {
    await page.close();
  }
}
const pointerOf = (b: DemoBrowser) => (b as unknown as { pointer: { moveToGlobal: (to: { x: number; y: number }) => Promise<void> } }).pointer;

const target = `<button id="go" style="position:absolute;left:100px;top:100px;width:100px;height:40px">Go</button>`;
const overlay = (attrs: string) => `<div id="ov" ${attrs} style="position:fixed;inset:0;background:#0006;z-index:50">Dialog</div>`;

describe.skipIf(!browser)("findCover: only something else on top is a cover", () => {
  const run = async (html: string, fn: (page: Page) => Promise<void>) => {
    const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(html);
      await fn(page);
    } finally {
      await page.close();
    }
  };
  const centre = async (page: Page, sel: string) => {
    const b = (await page.locator(sel).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  it("an ancestor on top (the target ignores pointer events) is not a cover", async () => {
    await run(`<div id="wrap" class="flex">Save logo<button id="go" style="pointer-events:none;width:100px;height:40px">Save logo</button></div>`, async (page) => {
      expect(await page.evaluate(() => document.elementFromPoint(50, 20)?.id)).toBe("wrap"); // the hit really is the wrapper
      expect((await findCover(page.locator("#go"), await centre(page, "#go"))).covered).toBe(false);
    });
  });

  it("flags an overlay that is on its way out (data-state=closed on it or an ancestor)", async () => {
    await run(`${target}<div data-state="closed" style="position:fixed;inset:0;z-index:50"><div id="in" style="width:100%;height:100%"></div></div>`, async (page) => {
      const r = await findCover(page.locator("#go"), await centre(page, "#go"));
      expect(r.covered).toBe(true);
      expect(r.hit?.closing).toBe(true);
    });
  });

  it("a plain overlay is not marked as closing", async () => {
    await run(`${target}${overlay('data-state="open"')}`, async (page) => {
      const r = await findCover(page.locator("#go"), await centre(page, "#go"));
      expect(r.covered).toBe(true);
      expect(r.hit?.closing).toBeFalsy();
    });
  });
});

describe.skipIf(!browser)("locate on a covered element", () => {
  it("waits out an overlay that is fading out, then succeeds", async () => {
    await withDemo(`${target}${overlay('data-state="closed"')}`, async (b, page) => {
      const t0 = Date.now();
      setTimeout(() => void page.evaluate(() => document.getElementById("ov")!.remove()), 800);
      const p = await b.locate("#go", pointerOf(b), 5000);
      expect(p.w).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(700); // it really waited for the overlay
    });
  });

  it("still fails with TARGET_COVERED when the closing overlay never goes away", async () => {
    await withDemo(`${target}${overlay('data-state="closed"')}`, async (b) => {
      const t0 = Date.now();
      const err = await b.locate("#go", pointerOf(b), 5000).catch((e) => e);
      expect(err).toBeInstanceOf(TargetError);
      expect(err.code).toBe("TARGET_COVERED");
      expect(err.message).toMatch(/covered by div#ov/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // it gave the overlay its grace time first
    });
  }, 15_000);

  it("fails at once for a real cover (a modal that stays), naming it as a candidate", async () => {
    await withDemo(`${target}${overlay('data-state="open"')}`, async (b) => {
      const t0 = Date.now();
      const err = await b.locate("#go", pointerOf(b), 5000).catch((e) => e);
      expect(err.code).toBe("TARGET_COVERED");
      expect(err.candidates[0]).toMatch(/div#ov/);
      expect(Date.now() - t0).toBeLessThan(1200);
    });
  });

  it("an element outside the viewport is described as that, never as 'covered by nothing'", async () => {
    await withDemo(`<div id="far" style="position:fixed;left:100px;top:5000px;width:100px;height:40px">Far</div>`, async (b) => {
      const err = await b.locate("#far", pointerOf(b), 5000).catch((e) => e);
      expect(err).toBeInstanceOf(TargetError);
      expect(err.code).toBe("TARGET_COVERED");
      expect(err.message).toMatch(/outside the (visible page|viewport)/);
      expect(err.message).not.toMatch(/covered by nothing/);
    });
  });
});

describe.skipIf(!browser)("timeouts are target errors", () => {
  const clean = (err: unknown) => {
    expect(err).toBeInstanceOf(TargetError);
    const e = err as TargetError;
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).not.toContain("\u001b");
    expect(e.message).toContain("#nope");
    expect(e.message).not.toMatch(/Call log/);
    expect(describeError(e)).toMatchObject({ code: "TIMEOUT", delivery: "not_delivered", retry: "safe" });
  };

  it("waitFor", async () => {
    await withDemo(target, async (b) => clean(await b.waitFor("#nope", 300).catch((e) => e)));
  });

  it("locate (what click and scroll use): nothing was sent, so it is safe to retry", async () => {
    await withDemo(target, async (b) => clean(await b.locate("#nope", pointerOf(b), 300).catch((e) => e)));
  });
});

describe("stripAnsi", () => {
  it("removes colour and style escapes", () => {
    expect(stripAnsi("\u001b[2m  - waiting for locator(...)\u001b[22m")).toBe("  - waiting for locator(...)");
  });
});
