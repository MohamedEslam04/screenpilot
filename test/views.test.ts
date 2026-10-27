import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { suggestViews } from "../src/analyze/detect.js";
import { initStoryboard } from "../src/init.js";
import { renderHtml } from "../src/render/html.js";
import { buildPlan } from "../src/render/plan.js";
import { camForRect, FULL, planViewCamera, zoomRect } from "../src/render/zoom.js";
import { lintStoryboard } from "../src/storyboard/load.js";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

const L = { x: 0, y: 0, w: 0.5, h: 1 };
const R = { x: 0.5, y: 0, w: 0.5, h: 1 };
const frame = { w: 960, h: 540 };
const cam = { w: 1920, h: 540 }; // 2 monitors of 960x540 side by side

describe("camForRect", () => {
  it("fills the frame with a monitor of matching aspect", () => {
    expect(camForRect(L, frame, cam)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(camForRect(R, frame, cam)).toEqual({ x: -960, y: 0, scale: 1 });
  });

  it("letterboxes the whole video, centered", () => {
    expect(camForRect(FULL, frame, cam)).toEqual({ x: 0, y: 135, scale: 0.5 });
  });

  it("zooms into a sub-rect", () => {
    const r = { x: 0.5, y: 0, w: 0.25, h: 0.5 };
    expect(camForRect(r, frame, cam)).toEqual({ x: -1920, y: 0, scale: 2 });
  });
});

describe("zoomRect", () => {
  it("is view/scale centred on the focus", () => {
    expect(zoomRect(R, 0.75, 0.5, 2)).toEqual({ x: 0.625, y: 0.25, w: 0.25, h: 0.5 });
  });

  it("clamps inside the view even when the focus is outside it", () => {
    expect(zoomRect(R, 0.1, 0.99, 2)).toEqual({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 });
    expect(zoomRect(R, 0.99, 0, 4)).toEqual({ x: 0.875, y: 0, w: 0.125, h: 0.25 });
  });
});

describe("planViewCamera", () => {
  const views = (cut = false) => [
    { start: 0, rect: L, cut: false },
    { start: 4, rect: R, cut },
  ];

  it("starts on the first view and pans to the next", () => {
    expect(planViewCamera(views(), [], frame, cam)).toEqual([
      { t: 0, dur: 0, x: 0, y: 0, scale: 1 },
      { t: 4, dur: 0.8, x: -960, y: 0, scale: 1 },
    ]);
  });

  it("cuts instantly (dur 0) for a cut transition", () => {
    expect(planViewCamera(views(true), [], frame, cam)[1]).toEqual({ t: 4, dur: 0, x: -960, y: 0, scale: 1 });
  });

  it("zooms inside the active view and returns to it, not identity", () => {
    const t = planViewCamera(views(), [{ start: 6, end: 8, x: 0.75, y: 0.5, scale: 2 }], frame, cam);
    expect(t[2]).toEqual({ t: 5.4, dur: 0.6, x: -2400, y: -270, scale: 2 }); // R centred, 2x
    expect(t[3]).toEqual({ t: 8, dur: 0.6, x: -960, y: 0, scale: 1 });
  });

  it("clamps a zoom to the view when the focus lies on another monitor", () => {
    const t = planViewCamera([{ start: 0, rect: L, cut: false }], [{ start: 2, end: 4, x: 0.9, y: 0.5, scale: 2 }], frame, cam);
    // zoom rect is the right-most quarter of L: x 0.25..0.5
    expect(t[1]).toMatchObject({ x: -960, scale: 2 });
  });

  it("pans straight from a zoom to a close view change, and between close zooms", () => {
    const t = planViewCamera(views(), [{ start: 2, end: 3.5, x: 0.25, y: 0.5, scale: 2 }], frame, cam);
    expect(t.map((x) => [x.t, x.scale])).toEqual([
      [0, 1],
      [1.4, 2],
      [4, 1], // no zoom-out tween: view pan takes over
    ]);
  });

  it("a cut clips a running tween", () => {
    const t = planViewCamera(
      [
        { start: 0, rect: L, cut: false },
        { start: 4, rect: R, cut: false },
        { start: 4.3, rect: L, cut: true },
      ],
      [],
      frame,
      cam,
    );
    expect(t[1]).toMatchObject({ t: 4, dur: 0.3 });
    expect(t[2]).toMatchObject({ t: 4.3, dur: 0 });
  });
});

describe("buildPlan with views", () => {
  const sb = StoryboardSchema.parse({
    source: "rec.mp4",
    screens: [
      { name: "L", ...L },
      { name: "R", ...R },
    ],
    views: [
      { at: 0, screen: "L" },
      { at: 4, screen: "R" },
      { at: 8, screen: "all", transition: "cut" },
      { at: 9, screen: "nope" },
    ],
    zooms: [{ at: 5, dur: 2, x: 0.75, y: 0.5, scale: 2 }],
    highlights: [{ at: 1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }],
  });
  const timeline = buildTimeline({ segments: [], holds: [], sourceDuration: 12, offset: 0 });
  const mk = (s = sb) =>
    buildPlan({
      sb: s,
      timeline,
      editedSrc: "e.mp4",
      editedHasAudio: false,
      source: { width: 3840, height: 1080 },
      narration: [],
      clicks: [{ t: 1, x: 0.75, y: 0.5 }],
    });

  it("sizes the frame to the first screen and #cam to the full video", () => {
    const p = mk();
    expect(p.frame.w / p.frame.h).toBeCloseTo(1920 / 1080, 2);
    expect(p.cam.w).toBeCloseTo(p.frame.w * 2, 5);
    expect(p.cam.h).toBeCloseTo(p.frame.h, 5);
  });

  it("plans pan then cut and ignores unknown screens", () => {
    const { camera, frame: f } = mk();
    expect(camera[0]).toEqual({ t: 0, dur: 0, x: 0, y: 0, scale: 1 });
    expect(camera.find((c) => c.t === 4)).toMatchObject({ dur: 0.8, x: -f.w, scale: 1 });
    expect(camera.at(-1)).toMatchObject({ t: 8, dur: 0 });
    expect(camera.at(-1)!.scale).toBeCloseTo(0.5);
  });

  it("emits tl.set for cuts and positions overlays in full-video coords", () => {
    const p = mk();
    const html = renderHtml(p, { gsapSrc: "g.js" });
    expect(html).toMatch(/tl\.set\("#cam", \{[^}]*\}, 8\)/);
    expect(html).toContain(`#cam { position: absolute; left: 0; top: 0; width: ${Math.round(p.cam.w * 1000) / 1000}px`);
    expect(html).toContain(`left:${Math.round(0.75 * p.cam.w * 1000) / 1000}px`);
    expect(html).not.toMatch(/Math\.random|Date\.now/);
  });

  it("without views the plan is the legacy one", () => {
    const p = mk(StoryboardSchema.parse({ source: "rec.mp4", zooms: [{ at: 2, dur: 2, x: 0.5, y: 0.5 }] }));
    expect(p.cam).toEqual({ w: p.frame.w, h: p.frame.h });
    expect(p.camera[0]).toMatchObject({ t: 1.4 });
  });
});

describe("schema / lint", () => {
  it("defaults views to pan and screens/views to empty", () => {
    const sb = StoryboardSchema.parse({ source: "a.mp4", views: [{ at: 1, screen: "all" }] });
    expect(sb.views[0]!.transition).toBe("pan");
    expect(StoryboardSchema.parse({ source: "a.mp4" }).screens).toEqual([]);
  });

  it("warns on a view with an unknown screen", () => {
    const sb = StoryboardSchema.parse({
      source: "a.mp4",
      screens: [{ name: "L", ...L }],
      views: [{ at: 0, screen: "L" }, { at: 1, screen: "X" }, { at: 2, screen: "all" }],
    });
    expect(lintStoryboard(sb)).toEqual(['views[1] names unknown screen "X"']);
  });
});

describe("suggestViews", () => {
  const screens = [
    { name: "L", ...L },
    { name: "R", ...R },
  ];
  const mv = (t: number, x: number) => ({ t, x, y: 0.5 });

  it("starts on the first move's monitor and switches after a 1s dwell", () => {
    const moves = [mv(0, 0.2), mv(1, 0.3), mv(3, 0.7), mv(4.5, 0.8), mv(6, 0.9)];
    expect(suggestViews(moves, screens)).toEqual([
      { at: 0, screen: "L", transition: "pan" },
      { at: 3, screen: "R", transition: "pan" },
    ]);
  });

  it("ignores brief visits and falls back to the first screen without moves", () => {
    expect(suggestViews([mv(0, 0.2), mv(2, 0.7), mv(2.4, 0.2), mv(5, 0.3)], screens)).toEqual([
      { at: 0, screen: "L", transition: "pan" },
    ]);
    expect(suggestViews([], screens)).toEqual([{ at: 0, screen: "L", transition: "pan" }]);
  });
});

describe("initStoryboard with canvasScreens", () => {
  it("copies screens from meta.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "demoreel-init-"));
    await mkdir(dir, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x180:d=2:r=10", "-pix_fmt", "yuv420p", join(dir, "rec.mp4")]);
    const canvasScreens = [
      { name: "L", ...L },
      { name: "R", ...R },
    ];
    await writeFile(join(dir, "meta.json"), JSON.stringify({ video: "rec.mp4", events: null, canvasScreens }));
    const { storyboard } = await initStoryboard(dir);
    const sb = JSON.parse(await readFile(storyboard, "utf8"));
    expect(sb.screens).toEqual(canvasScreens);
    expect(sb.views).toEqual([]);
  });
});
