import { describe, expect, it } from "vitest";
import { avfoundationArgs, captureScale, layout, parseAvfoundationScreens, screencaptureArgs, type AvInput } from "../src/record/backends/macos-avfoundation.js";

const opt = (args: string[], name: string) => args[args.indexOf(name) + 1];
const all = (args: string[], name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

// Points, as Quartz reports them; scale = pixels per point.
const retina: AvInput = { index: 0, rect: { x: 0, y: 0, w: 1470, h: 956 }, scale: 2 }; // MacBook Air 13"
const hd: AvInput = { index: 1, rect: { x: -1920, y: 0, w: 1920, h: 1080 }, scale: 1 }; // 1080p monitor on the left
const fiveK: AvInput = { index: 0, rect: { x: 0, y: 0, w: 2560, h: 1440 }, scale: 2 }; // iMac / Studio Display

describe("avfoundation device listing", () => {
  it("maps device numbers to display positions, ignoring cameras and audio", () => {
    const stderr = [
      "[AVFoundation indev @ 0x7f8b2c004a00] AVFoundation video devices:",
      "[AVFoundation indev @ 0x7f8b2c004a00] [0] FaceTime HD Camera",
      "[AVFoundation indev @ 0x7f8b2c004a00] [1] OBS Virtual Camera",
      "[AVFoundation indev @ 0x7f8b2c004a00] [2] Capture screen 0",
      "[AVFoundation indev @ 0x7f8b2c004a00] [3] Capture screen 1",
      "[AVFoundation indev @ 0x7f8b2c004a00] AVFoundation audio devices:",
      "[AVFoundation indev @ 0x7f8b2c004a00] [0] MacBook Pro Microphone",
      '[in#0 @ 0x600001b3c000] Error opening input: Input/output error',
      ": Input/output error",
    ].join("\n");
    expect(parseAvfoundationScreens(stderr)).toEqual([
      { device: 2, screen: 0 },
      { device: 3, screen: 1 },
    ]);
  });

  it("finds none in an empty or unrelated listing", () => {
    expect(parseAvfoundationScreens("Unknown input format: 'avfoundation'")).toEqual([]);
  });
});

describe("avfoundation capture geometry", () => {
  it("keeps a Retina display at full pixel density", () => {
    expect(captureScale([retina])).toBe(2);
    expect(layout([retina], 2)).toEqual({ w: 2940, h: 1912, places: [{ x: 0, y: 0, w: 2940, h: 1912 }] });
  });

  it("caps a 5K display to an encodable size", () => {
    const s = captureScale([fiveK]);
    expect(s).toBeCloseTo(1.6);
    expect(layout([fiveK], s)).toMatchObject({ w: 4096, h: 2304 });
  });

  it("lays mixed-density displays out at one density, in point positions", () => {
    const s = captureScale([hd, retina]);
    const { w, h, places } = layout([hd, retina], s);
    // 3390 x 1080 points; capped by width: 4096 / 3390 px per point.
    expect(s).toBeCloseTo(4096 / 3390);
    expect(w).toBe(4096);
    expect(places[0]).toEqual({ x: 0, y: 0, w: 2320, h: 1304 });
    expect(places[1]!.x).toBe(Math.round(1920 * s));
    expect(h).toBe(Math.round((1080 * s) / 2) * 2);
  });
});

describe("avfoundation ffmpeg arguments", () => {
  it("records one display by its avfoundation name with the cursor, scaled and encoded in hardware", () => {
    const args = avfoundationArgs([retina], "out.mkv");
    expect(opt(args, "-f")).toBe("avfoundation");
    expect(opt(args, "-i")).toBe("Capture screen 0:none");
    expect(opt(args, "-capture_cursor")).toBe("1");
    expect(opt(args, "-framerate")).toBe("30");
    expect(opt(args, "-filter_complex")).toBe("[0:v]scale=2940:1912:flags=bicubic,fps=30,format=yuv420p[out]");
    expect(opt(args, "-map")).toBe("[out]");
    expect(opt(args, "-c:v")).toBe("h264_videotoolbox");
    expect(args.at(-1)).toBe("out.mkv");
  });

  it("composes several displays on a black canvas", () => {
    const args = avfoundationArgs([hd, retina], "out.mkv", "libx264");
    expect(all(args, "-i")).toEqual(["Capture screen 1:none", "Capture screen 0:none"]);
    const graph = opt(args, "-filter_complex")!;
    expect(graph).toMatch(/^color=c=black:s=4096x\d+:r=30\[bg\];/);
    expect(graph).toContain("[0:v]scale=2320:1304:flags=bicubic[s0]");
    expect(graph).toContain("[bg][s0]overlay=0:0:shortest=1[o0]");
    expect(graph).toContain(`[o0][s1]overlay=${Math.round(1920 * (4096 / 3390))}:0:shortest=1[mix]`);
    expect(graph.endsWith("[mix]fps=30,format=yuv420p[out]")).toBe(true);
    expect(opt(args, "-c:v")).toBe("libx264");
  });

  it("needs at least one display", () => {
    expect(() => avfoundationArgs([], "out.mkv")).toThrow("No display");
  });
});

describe("screencapture arguments", () => {
  it("grabs a display's point rect silently with the cursor", () => {
    expect(screencaptureArgs({ x: -1920, y: -200.4, w: 1920, h: 1080 }, "/tmp/a.png")).toEqual(["-x", "-C", "-R-1920,-200,1920,1080", "-t", "png", "/tmp/a.png"]);
  });
});
