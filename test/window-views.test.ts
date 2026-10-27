import { describe, expect, it } from "vitest";
import { suggestWindowViews } from "../src/analyze/detect.js";
import { buildPlan } from "../src/render/plan.js";
import { normalizeWindows } from "../src/record/normalize.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const rep = (t: number, id: string, x: number, y: number, w: number, h: number, cls = "app") => ({ t, id, cls, title: id, x, y, w, h });

describe("normalizeWindows", () => {
  it("maps desktop px to recording coords, clips, and drops windows off the recording", () => {
    const out = normalizeWindows(
      [
        { at: 500, id: "a", cls: "brave", title: "A", x: 32, y: 32, w: 1856, h: 1016 },
        { at: 900, id: "b", cls: "kate", title: "B", x: 1920 + 100, y: 0, w: 800, h: 600 }, // other monitor
      ],
      1000,
      { x: 0, y: 0, w: 1920, h: 1080 },
      { x: 0, y: 0, w: 1, h: 1 },
    );
    expect(out).toEqual([{ t: 0, id: "a", cls: "brave", title: "A", x: 0.0167, y: 0.0296, w: 0.9667, h: 0.9407 }]);
  });
});

describe("suggestWindowViews", () => {
  it("frames each window that stays active, with a margin kept inside its monitor", () => {
    const views = suggestWindowViews(
      [rep(0, "browser", 0.01, 0.03, 0.48, 0.94), rep(5, "kate", 0.52, 0.05, 0.46, 0.9)],
      { screens: [{ name: "L", x: 0, y: 0, w: 0.5, h: 1 }, { name: "R", x: 0.5, y: 0, w: 0.5, h: 1 }] },
    );
    expect(views.map((v) => [v.at, v.label])).toEqual([
      [0, "browser"],
      [5, "kate"],
    ]);
    expect(views[0]!.rect.x + views[0]!.rect.w).toBeLessThanOrEqual(0.5); // stays on its monitor
    expect(views[1]!.rect.x).toBeGreaterThanOrEqual(0.5);
  });

  it("ignores shell surfaces, tiny windows and short flickers", () => {
    const views = suggestWindowViews([
      rep(0, "browser", 0, 0, 0.9, 0.9),
      rep(2, "panel", 0, 0, 1, 0.05, "org.kde.plasmashell"),
      rep(3, "popup", 0.4, 0.4, 0.1, 0.1),
      rep(4, "flash", 0.1, 0.1, 0.6, 0.6),
      rep(4.2, "browser", 0, 0, 0.9, 0.9),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]!.label).toBe("browser");
  });

  it("keeps only the final shape of a window fitted before recording (maximized → normal → 16:9)", () => {
    const views = suggestWindowViews([
      rep(0, "dolphin", 0.5, 0.046, 0.5, 0.954),
      rep(0, "dolphin", 0.57, 0.1, 0.23, 0.8),
      rep(0, "dolphin", 0.522, 0.066, 0.457, 0.915),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]!.rect).toMatchObject({ x: 0.522, w: 0.457 });
  });

  it("lets a window that is moved right after opening settle into one view", () => {
    const views = suggestWindowViews([rep(1, "kate", 0.3, 0.3, 0.3, 0.3), rep(1.2, "kate", 0.05, 0.05, 0.9, 0.9)]);
    expect(views).toHaveLength(1);
    expect(views[0]!.rect.w).toBeGreaterThan(0.85);
  });
});

describe("rect views", () => {
  it("need exactly one of screen or rect", () => {
    const base = { source: "x.mp4" };
    expect(StoryboardSchema.safeParse({ ...base, views: [{ at: 0, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }).success).toBe(true);
    expect(StoryboardSchema.safeParse({ ...base, views: [{ at: 0 }] }).success).toBe(false);
    expect(StoryboardSchema.safeParse({ ...base, views: [{ at: 0, screen: "all", rect: { x: 0, y: 0, w: 1, h: 1 } }] }).success).toBe(false);
  });

  it("frame a window: output-shaped frame, first rect fills it, camera pans to the next", () => {
    const sb = StoryboardSchema.parse({
      source: "x.mp4",
      views: [
        { at: 0, rect: { x: 0.0, y: 0.0, w: 0.5, h: 0.5 } },
        { at: 5, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
      ],
    });
    const plan = buildPlan({
      sb,
      timeline: buildTimeline({ segments: [], holds: [], sourceDuration: 10 }),
      editedSrc: "e.mp4",
      editedHasAudio: false,
      source: { width: 1920, height: 1080 },
      narration: [],
      clicks: [],
    });
    expect(plan.frame.w / plan.frame.h).toBeCloseTo(16 / 9, 2);
    expect(Math.abs(plan.cam.w - plan.frame.w * 2)).toBeLessThan(2); // half the source fills the frame
    const first = plan.camera[0]!;
    expect(first.t).toBe(0);
    expect(Math.abs(first.x)).toBeLessThan(1);
    expect(Math.abs(first.y)).toBeLessThan(1);
    expect(first.scale).toBeCloseTo(1, 2);
    const pan = plan.camera.find((c) => c.t === 5)!;
    expect(Math.abs(pan.x + plan.frame.w)).toBeLessThan(1);
    expect(Math.abs(pan.y + plan.frame.h)).toBeLessThan(1);
  });
});

describe("camForRect cover", async () => {
  const { camForRect } = await import("../src/render/zoom.js");
  it("fills the frame with a wide window and trims its sides instead of showing above/below", () => {
    const frame = { w: 1600, h: 900 };
    const cam = { w: 3200, h: 900 }; // 32:9 source, scale 1 = whole height
    const wide = { x: 0.5, y: 0.05, w: 0.5, h: 0.9 }; // 1600x810 window: wider than 16:9
    const contain = camForRect(wide, frame, cam);
    const cover = camForRect(wide, frame, cam, true);
    expect(cover.scale).toBeGreaterThan(contain.scale);
    // with cover, the window's top edge sits at or above the frame top: nothing above it shows
    expect(cover.y + cover.scale * wide.y * cam.h).toBeLessThanOrEqual(0.5);
    expect(cover.y + cover.scale * (wide.y + wide.h) * cam.h).toBeGreaterThanOrEqual(frame.h - 0.5);
  });
});
