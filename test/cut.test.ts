import { describe, expect, it } from "vitest";
import { buildCutFilter } from "../src/render/cut.js";
import { SegmentSchema } from "../src/storyboard/schema.js";
import { buildTimeline } from "../src/storyboard/timeline.js";

describe("buildCutFilter", () => {
  it("cuts, speeds up and freezes", () => {
    const tl = buildTimeline({
      segments: [
        { in: 0, out: 2, speed: 1 },
        { in: 5, out: 9, speed: 2 },
      ],
      holds: [{ at: 1, dur: 1.5 }],
      sourceDuration: 10,
    });
    const graph = buildCutFilter({ pieces: tl.pieces, fps: 30, sourceDuration: 10, keepAudio: false });
    expect(graph).toMatchInlineSnapshot(`
      "[0:v]split=4[vs0][vs1][vs2][vs3];
      [vs0]trim=start=0.000:end=1.000,setpts=(PTS-STARTPTS)/1,fps=30[v0];
      [vs1]trim=start=1.000,setpts=PTS-STARTPTS,fps=30,trim=end_frame=1,tpad=stop_mode=clone:stop_duration=1.500,trim=duration=1.500[v1];
      [vs2]trim=start=1.000:end=2.000,setpts=(PTS-STARTPTS)/1,fps=30[v2];
      [vs3]trim=start=5.000:end=9.000,setpts=(PTS-STARTPTS)/2,fps=30[v3];
      [v0][v1][v2][v3]concat=n=4:v=1:a=0[cv];
      [cv]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[vout]"
    `);
  });

  it("keeps source audio in sync with silence during holds", () => {
    const tl = buildTimeline({ segments: [], holds: [{ at: 1, dur: 1 }], sourceDuration: 3 });
    const graph = buildCutFilter({ pieces: tl.pieces, fps: 30, sourceDuration: 3, keepAudio: true });
    expect(graph).toContain("[0:a]asplit=3[as0][as1][as2]");
    expect(graph).toContain("aevalsrc=0:d=1.000:s=48000:c=stereo[a1]");
    expect(graph).toContain("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[cv][aout]");
  });

  it("freezes a hold at the very end on the last real frame", () => {
    const tl = buildTimeline({ segments: [], holds: [{ at: 3, dur: 1 }], sourceDuration: 3 });
    const graph = buildCutFilter({ pieces: tl.pieces, fps: 30, sourceDuration: 3, keepAudio: false });
    expect(graph).toContain("[vs1]trim=start=2.933");
  });

  it("applies a segment volume (and mute = 0) to the source audio only", () => {
    const tl = buildTimeline({
      segments: [
        { in: 0, out: 2, speed: 1, volume: 0.5 },
        { in: 2, out: 4, speed: 2, mute: true },
        { in: 4, out: 6, speed: 1 },
      ],
      holds: [],
      sourceDuration: 6,
    });
    const graph = buildCutFilter({ pieces: tl.pieces, fps: 30, sourceDuration: 6, keepAudio: true });
    expect(graph).toContain("[as0]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS,atempo=1.0000,volume=0.5[a0]");
    expect(graph).toContain("[as1]atrim=start=2.000:end=4.000,asetpts=PTS-STARTPTS,atempo=2.0000,volume=0[a1]");
    expect(graph).toContain("[as2]atrim=start=4.000:end=6.000,asetpts=PTS-STARTPTS,atempo=1.0000[a2]");
    expect(graph).toContain("concat=n=3:v=1:a=1[cv][aout]");
  });

  it("changes the filter (and so the cut cache key) when a volume changes", () => {
    const cut = (volume: number) =>
      buildCutFilter({
        pieces: buildTimeline({ segments: [{ in: 0, out: 2, speed: 1, volume }], holds: [], sourceDuration: 2 }).pieces,
        fps: 30,
        sourceDuration: 2,
        keepAudio: true,
      });
    expect(cut(1)).not.toBe(cut(2));
  });

  it("keeps a muted segment silent but in the concat when the freeze after it is a hold", () => {
    const tl = buildTimeline({ segments: [{ in: 0, out: 2, speed: 1, mute: true }], holds: [{ at: 1, dur: 1 }], sourceDuration: 2 });
    const graph = buildCutFilter({ pieces: tl.pieces, fps: 30, sourceDuration: 2, keepAudio: true });
    expect(graph).toContain("volume=0[a0]");
    expect(graph).toContain("aevalsrc=0:d=1.000:s=48000:c=stereo[a1]");
    expect(graph).toContain("concat=n=3:v=1:a=1[cv][aout]");
  });
});

describe("segment audio fields", () => {
  it("accepts volume 0..4 and mute, and leaves them unset by default", () => {
    expect(SegmentSchema.parse({ in: 0, out: 1 })).toMatchObject({ speed: 1 });
    expect(SegmentSchema.parse({ in: 0, out: 1 }).volume).toBeUndefined();
    expect(SegmentSchema.parse({ in: 0, out: 1, volume: 4, mute: true })).toMatchObject({ volume: 4, mute: true });
    expect(SegmentSchema.safeParse({ in: 0, out: 1, volume: 4.5 }).success).toBe(false);
    expect(SegmentSchema.safeParse({ in: 0, out: 1, volume: -1 }).success).toBe(false);
  });
});
