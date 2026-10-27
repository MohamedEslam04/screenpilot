import { describe, expect, it } from "vitest";
import { dwellPoints, idleSpans, parseFreezes, suggestSegments, suggestZooms } from "../src/analyze/detect.js";

describe("parseFreezes", () => {
  it("reads start/end pairs and closes an open freeze at the end", () => {
    const log = [
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2.5",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 5.5",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 9",
    ].join("\n");
    expect(parseFreezes(log, 12)).toEqual([
      { start: 2.5, end: 5.5 },
      { start: 9, end: 12 },
    ]);
  });
});

describe("idleSpans", () => {
  it("drops short freezes and freezes with clicks inside", () => {
    const spans = [
      { start: 0, end: 1 },
      { start: 2, end: 6 },
      { start: 8, end: 14 },
    ];
    expect(idleSpans(spans, [{ t: 10, x: 0.5, y: 0.5 }])).toEqual([{ start: 2, end: 6 }]);
  });
});

describe("suggestSegments", () => {
  it("cuts the middle of idle spans", () => {
    expect(suggestSegments(20, [{ start: 5, end: 12 }])).toEqual([
      { in: 0, out: 5.6, speed: 1 },
      { in: 11.4, out: 20, speed: 1 },
    ]);
  });

  it("fast-forwards instead of cutting when idle is most of the video", () => {
    expect(suggestSegments(20, [{ start: 0, end: 20 }])).toEqual([
      { in: 0, out: 0.6, speed: 1 },
      { in: 0.6, out: 19.4, speed: 4 },
      { in: 19.4, out: 20, speed: 1 },
    ]);
  });

  it("keeps short idle spans", () => {
    expect(suggestSegments(10, [{ start: 2, end: 4 }])).toEqual([{ in: 0, out: 10, speed: 1 }]);
  });
});

describe("dwellPoints", () => {
  it("finds where the pointer rested after travelling", () => {
    const moves = [
      { t: 0, x: 0.1, y: 0.1 },
      { t: 0.1, x: 0.3, y: 0.3 },
      { t: 0.2, x: 0.5, y: 0.5 },
      { t: 1.5, x: 0.51, y: 0.5 }, // rested 1.3s at (0.5, 0.5)
      { t: 1.6, x: 0.52, y: 0.5 },
    ];
    expect(dwellPoints(moves)).toEqual([{ t: 0.2, x: 0.5, y: 0.5 }]);
  });
});

describe("suggestZooms", () => {
  it("groups nearby clicks and splits distant ones", () => {
    const zooms = suggestZooms([
      { t: 2, x: 0.8, y: 0.2 },
      { t: 3, x: 0.82, y: 0.22 },
      { t: 10, x: 0.2, y: 0.8 },
    ]);
    expect(zooms).toEqual([
      { at: 1.6, dur: 3, x: 0.81, y: 0.21, scale: 1.8 },
      { at: 9.6, dur: 2, x: 0.2, y: 0.8, scale: 1.8 },
    ]);
  });
});
