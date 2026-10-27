import { describe, expect, it } from "vitest";
import { buildCutFilter } from "../src/render/cut.js";
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
});
