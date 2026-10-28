import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPaths, parseFormats } from "../src/render/formats.js";

describe("parseFormats", () => {
  it.each([
    { input: "16:9", expected: [{ label: "16x9", width: 1920, height: 1080 }] },
    { input: "9:16", expected: [{ label: "9x16", width: 1080, height: 1920 }] },
    { input: "1:1", expected: [{ label: "1x1", width: 1080, height: 1080 }] },
    {
      input: "16:9,9:16,1:1",
      expected: [
        { label: "16x9", width: 1920, height: 1080 },
        { label: "9x16", width: 1080, height: 1920 },
        { label: "1x1", width: 1080, height: 1080 },
      ],
    },
    { input: " 9:16 , 1:1 ", expected: [{ label: "9x16", width: 1080, height: 1920 }, { label: "1x1", width: 1080, height: 1080 }] },
    { input: "1280x720", expected: [{ label: "1280x720", width: 1280, height: 720 }] },
    { input: "720X1280", expected: [{ label: "720x1280", width: 720, height: 1280 }] },
    { input: "9:16,9:16", expected: [{ label: "9x16", width: 1080, height: 1920 }] },
    { input: "1920x1080,16:9", expected: [{ label: "1920x1080", width: 1920, height: 1080 }, { label: "16x9", width: 1920, height: 1080 }] },
  ])("parses $input", ({ input, expected }) => {
    expect(parseFormats(input)).toEqual(expected);
  });

  it.each(["", "  ", "4:3", "wide", "1920x", "x1080", "0x100", "1920x1080x3", "9:16,,1:1", "-5x100", "1.5x2"])("rejects %j", (input) => {
    expect(() => parseFormats(input)).toThrow(/format/i);
  });

  it("rejects sizes the encoder cannot do", () => {
    expect(() => parseFormats("1081x1920")).toThrow(/even/);
  });

  it("names the accepted formats in the error", () => {
    expect(() => parseFormats("4:3")).toThrow(/16:9.*9:16.*1:1.*WxH/);
  });
});

describe("formatPaths", () => {
  const fmt = { label: "9x16", width: 1080, height: 1920 };

  it("puts the format between the name and the extension", () => {
    expect(formatPaths("/work/demo/storyboard.json", fmt)).toEqual({
      buildDir: "/work/demo/storyboard.9x16.build",
      output: "/work/demo/storyboard.9x16.mp4",
    });
  });

  it("adds the partial-render window after the format", () => {
    expect(formatPaths("/work/demo/storyboard.json", fmt, { from: 12, to: 20 })).toEqual({
      buildDir: "/work/demo/storyboard.9x16.part-12-20.build",
      output: "/work/demo/storyboard.9x16.part-12-20.mp4",
    });
  });

  it("derives the output from --output as a base name", () => {
    expect(formatPaths("/work/demo/storyboard.json", fmt, undefined, "out/demo.mp4").output).toBe(resolve("out/demo.9x16.mp4"));
    expect(formatPaths("/work/demo/storyboard.json", fmt, undefined, "out/demo").output).toBe(resolve("out/demo.9x16.mp4"));
  });

  it("keeps build dirs apart per format", () => {
    const a = formatPaths("/w/s.json", { label: "16x9", width: 1920, height: 1080 });
    const b = formatPaths("/w/s.json", fmt);
    expect(a.buildDir).not.toBe(b.buildDir);
    expect(a.output).not.toBe(b.output);
  });
});
