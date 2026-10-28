import type { Piece } from "../storyboard/timeline.js";

export interface CutOptions {
  source: string;
  output: string;
  pieces: Piece[];
  fps: number;
  sourceDuration: number;
  keepAudio: boolean;
}

const f = (n: number) => n.toFixed(3);

/** atempo accepts 0.5..100 per instance; chain for slower speeds. */
function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

/** Filter graph that cuts, speeds up and freezes the source into one CFR stream. */
export function buildCutFilter(opts: Omit<CutOptions, "source" | "output">): string {
  const { pieces, fps, sourceDuration, keepAudio } = opts;
  const n = pieces.length;
  const lines: string[] = [];
  const vSplit = Array.from({ length: n }, (_, i) => `[vs${i}]`).join("");
  lines.push(n > 1 ? `[0:v]split=${n}${vSplit}` : `[0:v]null[vs0]`);
  if (keepAudio) {
    const aSplit = Array.from({ length: n }, (_, i) => `[as${i}]`).join("");
    lines.push(n > 1 ? `[0:a]asplit=${n}${aSplit}` : `[0:a]anull[as0]`);
  }

  const lastFrame = Math.max(0, sourceDuration - 2 / fps);
  pieces.forEach((p, i) => {
    if (p.kind === "play") {
      lines.push(`[vs${i}]trim=start=${f(p.in)}:end=${f(p.out)},setpts=(PTS-STARTPTS)/${p.speed},fps=${fps}[v${i}]`);
      if (keepAudio) {
        const gain = p.volume === 1 ? "" : `,volume=${+p.volume.toFixed(3)}`;
        lines.push(`[as${i}]atrim=start=${f(p.in)}:end=${f(p.out)},asetpts=PTS-STARTPTS,${atempoChain(p.speed)}${gain}[a${i}]`);
      }
    } else {
      const at = Math.min(p.at, lastFrame);
      lines.push(
        `[vs${i}]trim=start=${f(at)},setpts=PTS-STARTPTS,fps=${fps},trim=end_frame=1,` +
          `tpad=stop_mode=clone:stop_duration=${f(p.dur)},trim=duration=${f(p.dur)}[v${i}]`,
      );
      if (keepAudio) {
        lines.push(`[as${i}]anullsink`);
        lines.push(`aevalsrc=0:d=${f(p.dur)}:s=48000:c=stereo[a${i}]`);
      }
    }
  });

  const ins = pieces.map((_, i) => (keepAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  const outs = keepAudio ? "[cv][aout]" : "[cv]";
  lines.push(`${ins}concat=n=${n}:v=1:a=${keepAudio ? 1 : 0}${outs}`);
  lines.push(`[cv]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[vout]`);
  return lines.join(";\n");
}

/** `scriptFlag` is `-/filter_complex` on ffmpeg 7+, `-filter_complex_script` before. */
export function buildCutArgs(opts: CutOptions, filterScriptPath: string, scriptFlag: string): string[] {
  return [
    "-y",
    "-loglevel",
    "error",
    "-i",
    opts.source,
    scriptFlag,
    filterScriptPath,
    "-map",
    "[vout]",
    ...(opts.keepAudio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-r",
    String(opts.fps),
    // A keyframe every second keeps headless-Chrome seeking exact and fast.
    "-g",
    String(opts.fps),
    "-movflags",
    "+faststart",
    opts.output,
  ];
}
