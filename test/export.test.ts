import { describe, expect, it } from "vitest";
import { buildGifArgs, buildPosterArgs, buildWebmArgs, extraPath, parseExtras, posterTime } from "../src/render/export.js";

describe("parseExtras", () => {
  it("reads a comma list, once each", () => {
    expect(parseExtras("gif,webm,poster")).toEqual(["gif", "webm", "poster"]);
    expect(parseExtras(" GIF , gif ")).toEqual(["gif"]);
    expect(parseExtras(["poster"])).toEqual(["poster"]);
    expect(parseExtras(undefined)).toEqual([]);
  });

  it("rejects anything else", () => {
    expect(() => parseExtras("gif,mov")).toThrow(/mov/);
  });
});

describe("extraPath", () => {
  it("names each file after the video", () => {
    expect(extraPath("/o/demo.mp4", "gif")).toBe("/o/demo.gif");
    expect(extraPath("/o/demo.mp4", "webm")).toBe("/o/demo.webm");
    expect(extraPath("/o/demo.mp4", "poster")).toBe("/o/demo.poster.png");
  });
});

describe("buildGifArgs", () => {
  it("makes a palette from the video itself, scaled down but never up", () => {
    const a = buildGifArgs("in.mp4", "out.gif", { width: 800, fps: 12 });
    const filter = a[a.indexOf("-vf") + 1]!;
    expect(filter).toContain("fps=12");
    expect(filter).toContain("scale=min(800\\,iw):-2:flags=lanczos");
    expect(filter).toContain("palettegen");
    expect(filter).toContain("paletteuse");
    expect(a).toContain("-an");
    expect(a.at(-1)).toBe("out.gif");
  });
});

describe("buildWebmArgs", () => {
  it("encodes VP9 and keeps the sound when there is some", () => {
    const a = buildWebmArgs("in.mp4", "out.webm");
    expect(a.join(" ")).toContain("-c:v libvpx-vp9");
    expect(a.join(" ")).toContain("-map 0:a?");
    expect(a.join(" ")).toContain("-c:a libopus");
    expect(a.at(-1)).toBe("out.webm");
  });
});

describe("posterTime", () => {
  it("is the asked-for time, kept inside the video", () => {
    expect(posterTime(40, 12)).toBe(12);
    expect(posterTime(40, 99)).toBeCloseTo(39.9, 3);
    expect(posterTime(40, -3)).toBe(0);
  });

  it("is a quarter of the way in by default", () => {
    expect(posterTime(40, undefined)).toBe(10);
  });
});

describe("buildPosterArgs", () => {
  it("grabs one frame", () => {
    const a = buildPosterArgs("in.mp4", "out.png", 7.5);
    expect(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 2)).toEqual(["-ss", "7.5"]);
    expect(a).toContain("-frames:v");
    expect(a.at(-1)).toBe("out.png");
  });
});
