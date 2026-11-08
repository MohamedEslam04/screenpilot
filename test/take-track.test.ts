import { describe, expect, it } from "vitest";
import { StepSchema } from "../src/take/schema.js";
import { globalRectToRecording, type Measured, spanEnd, trackedHighlights, trackElement } from "../src/take/track.js";

/** Samples every 0.25 s from `from` to `to`, visible where `vis(t)` says. */
function samples(from: number, to: number, vis: (t: number) => boolean): { t: number; visible: boolean }[] {
  const out: { t: number; visible: boolean }[] = [];
  for (let i = Math.round(from * 4); i <= Math.round(to * 4); i++) out.push({ t: i / 4, visible: vis(i / 4) });
  return out;
}

describe("globalRectToRecording", () => {
  it("subtracts the origin of a monitor that is not at global 0,0 (padding included)", () => {
    const r = globalRectToRecording({ x: 2884, y: 34, w: 952, h: 100 }, { x: 1920, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1, h: 1 });
    expect(r.x).toBeCloseTo(0.499, 3);
    expect(r.y).toBeCloseTo(0.0259, 3);
    // The padded right edge (3842) is past the monitor's (3840): clipped there.
    expect(r.w).toBeCloseTo(962 / 1920, 3);
    expect(r.h).toBeCloseTo(112 / 1080, 3);
  });

  it("maps into a letterboxed content rect like normalizeEvents", () => {
    const r = globalRectToRecording({ x: 6, y: 6, w: 948, h: 528 }, { x: 0, y: 0, w: 1920, h: 1080 }, { x: 0.1, y: 0, w: 0.8, h: 1 });
    expect(r.x).toBeCloseTo(0.1, 4);
    expect(r.w).toBeCloseTo(0.4, 4);
    expect(r.h).toBeCloseTo(0.5, 4);
  });

  it("clips to 0..1 of the recording", () => {
    const r = globalRectToRecording({ x: -100, y: 1000, w: 300, h: 300 }, { x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1, h: 1 });
    expect(r.x).toBe(0);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
    expect(r.x + r.w).toBeCloseTo(206 / 1920, 3);
  });
});

describe("spanEnd", () => {
  it("ignores a short gap and ends where the element stays gone", () => {
    const s = samples(0, 5, (t) => t < 2 || (t >= 2.5 && t < 3));
    expect(spanEnd(s, 0, 8)).toBe(3);
  });

  it("never exceeds start + max", () => {
    const s = samples(0, 20, () => true);
    expect(spanEnd(s, 0, 8)).toBe(8);
    expect(spanEnd(samples(0, 20, (t) => t < 12), 1, 8)).toBe(9);
  });

  it("ignores samples before start", () => {
    const s = samples(0, 6, (t) => t >= 1);
    expect(spanEnd(s, 1, 8)).toBe(9);
  });
});

describe("trackElement", () => {
  /** A fake clock that the fake measure advances. */
  function fake(visible: (t: number) => boolean, rect = { x: 100, y: 200, w: 50, h: 20 }) {
    let t = 10;
    const measure = async (): Promise<Measured | null> => (visible(t) ? { ...rect, covered: false } : null);
    const wait = async (ms: number) => {
      t += ms / 1000;
    };
    return { now: () => t, measure, wait };
  }

  it("starts at the first visible sample and ends when the element is gone", async () => {
    const f = fake((t) => t >= 10.5 && t < 12);
    const r = await trackElement("[data-toast]", { startedAt: 10, max: 8, ...f });
    expect(r).not.toBeNull();
    expect(r!.at).toBeCloseTo(10.5, 5);
    expect(r!.end).toBeCloseTo(12, 5);
    expect(r!.rect).toEqual({ x: 100, y: 200, w: 50, h: 20 });
  });

  it("counts a covered element as not visible", async () => {
    let t = 0;
    const measure = async (): Promise<Measured | null> => ({ x: 0, y: 0, w: 10, h: 10, covered: t >= 2 });
    const r = await trackElement("#x", { startedAt: 0, max: 8, now: () => t, measure, wait: async (ms) => void (t += ms / 1000) });
    expect(r!.end).toBeCloseTo(2, 5);
  });

  it("stops at the cap when the element stays", async () => {
    const f = fake(() => true);
    const r = await trackElement("#x", { startedAt: 10, max: 3, ...f });
    expect(r!.at).toBe(10);
    expect(r!.end).toBe(13);
  });

  it("ends where it is stopped (until next)", async () => {
    const f = fake(() => true);
    const stop = new AbortController();
    const wait = async (ms: number) => {
      await f.wait(ms);
      if (f.now() >= 11.5) stop.abort();
    };
    const r = await trackElement("#x", { startedAt: 10, max: 8, now: f.now, measure: f.measure, wait, signal: stop.signal });
    expect(r!.end).toBeCloseTo(11.5, 5);
  });

  it("returns null when the element never shows", async () => {
    const f = fake(() => false);
    expect(await trackElement("#x", { startedAt: 10, max: 2, ...f })).toBeNull();
  });

  it("treats a failing measure as not visible", async () => {
    let t = 0;
    const measure = async (): Promise<Measured | null> => {
      if (t >= 1) throw new Error("page navigated");
      return { x: 0, y: 0, w: 10, h: 10, covered: false };
    };
    const r = await trackElement("#x", { startedAt: 0, max: 8, now: () => t, measure, wait: async (ms) => void (t += ms / 1000) });
    expect(r!.end).toBeCloseTo(1, 5);
  });
});

describe("trackedHighlights", () => {
  const screen = { x: 1920, y: 0, w: 1920, h: 1080 };
  const content = { x: 0, y: 0, w: 1, h: 1 };
  const rect = { x: 2884, y: 34, w: 952, h: 100 };

  it("turns spans into storyboard highlights in recording coordinates", () => {
    const { highlights, warnings } = trackedHighlights([{ selector: "[data-toast]", label: "Saved", span: { at: 3.214, end: 6.5, rect } }], screen, content);
    expect(warnings).toEqual([]);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toMatchObject({ at: 3.21, dur: 3.29, label: "Saved" });
    expect(highlights[0]!.x).toBeCloseTo(0.499, 3);
  });

  it("drops a span under 0.6 s with a warning naming the selector", () => {
    const { highlights, warnings } = trackedHighlights([{ selector: "[data-toast]", span: { at: 3, end: 3.5, rect } }], screen, content);
    expect(highlights).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[data-toast]");
  });

  it("warns when the element never showed", () => {
    const { highlights, warnings } = trackedHighlights([{ selector: "#gone", span: null }], screen, content);
    expect(highlights).toEqual([]);
    expect(warnings[0]).toContain("#gone");
  });

  it("warns when the element is outside the recorded area", () => {
    const { highlights, warnings } = trackedHighlights([{ selector: "#left", span: { at: 1, end: 4, rect: { x: 100, y: 100, w: 50, h: 50 } } }], screen, content);
    expect(highlights).toEqual([]);
    expect(warnings[0]).toContain("#left");
  });
});

describe("highlight step schema", () => {
  it("parses with only a web selector", () => {
    expect(StepSchema.safeParse({ highlight: { web: "[data-sonner-toast]" } }).success).toBe(true);
  });

  it("takes dur, label and until", () => {
    expect(StepSchema.safeParse({ highlight: { web: "#a", dur: 4, label: "Saved", until: "next" } }).success).toBe(true);
  });

  it("rejects other until values", () => {
    expect(StepSchema.safeParse({ highlight: { web: "#a", until: "later" } }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(StepSchema.safeParse({ highlight: { web: "#a", colour: "red" } }).success).toBe(false);
  });
});
