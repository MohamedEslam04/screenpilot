import type { Piece } from "../storyboard/timeline.js";
import { XFADE } from "./xfade.js";

export interface CutOptions {
  source: string;
  output: string;
  pieces: Piece[];
  fps: number;
  sourceDuration: number;
  keepAudio: boolean;
  /** Color grade of the recording. */
  grade?: { brightness: number; contrast: number; saturation: number; gamma: number };
  /** Reduce steady noise in the source audio. */
  denoise?: boolean;
  /** Fast, lighter intermediate for `-q draft`. */
  draft?: boolean;
}

const f = (n: number) => n.toFixed(3);
/** A number as short as it can be, at millisecond precision. */
const g = (n: number) => String(Math.round(n * 1000) / 1000);

/** FFT denoise: 18 dB less steady noise, tracking the noise level (the defaults assume -50 dB and change nothing on a normal recording). */
const DENOISE = "afftdn=nr=18:nf=-30:tn=1";

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

/** `eq=...,` with only the values that differ from neutral, or nothing. */
function gradeFilter(g: CutOptions["grade"]): string {
  if (!g) return "";
  const parts = [
    g.brightness !== 0 ? `brightness=${g.brightness}` : "",
    g.contrast !== 1 ? `contrast=${g.contrast}` : "",
    g.saturation !== 1 ? `saturation=${g.saturation}` : "",
    g.gamma !== 1 ? `gamma=${g.gamma}` : "",
  ].filter(Boolean);
  return parts.length ? `eq=${parts.join(":")},` : "";
}

/** Filter graph that cuts, speeds up and freezes the source into one CFR stream. */
export function buildCutFilter(opts: Omit<CutOptions, "source" | "output" | "draft">): string {
  const { pieces, fps, sourceDuration, keepAudio, denoise, grade } = opts;
  const n = pieces.length;
  const blends = pieces.some((p) => p.transition);
  // xfade wants every input in the same timebase, and concat's output is not the fps one.
  const tb = blends ? ",settb=AVTB" : "";
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
      lines.push(`[vs${i}]trim=start=${f(p.in)}:end=${f(p.out)},setpts=(PTS-STARTPTS)/${p.speed},fps=${fps}${tb}[v${i}]`);
      if (keepAudio) {
        const gain = p.volume === 1 ? "" : `,volume=${+p.volume.toFixed(3)}`;
        lines.push(`[as${i}]atrim=start=${f(p.in)}:end=${f(p.out)},asetpts=PTS-STARTPTS,${atempoChain(p.speed)}${denoise ? `,${DENOISE}` : ""}${gain}${blends ? ",aformat=sample_rates=48000:channel_layouts=stereo" : ""}[a${i}]`);
      }
    } else {
      const at = Math.min(p.at, lastFrame);
      lines.push(
        `[vs${i}]trim=start=${f(at)},setpts=PTS-STARTPTS,fps=${fps},trim=end_frame=1,` +
          `tpad=stop_mode=clone:stop_duration=${f(p.dur)},trim=duration=${f(p.dur)}${tb}[v${i}]`,
      );
      if (keepAudio) {
        lines.push(`[as${i}]anullsink`);
        lines.push(`aevalsrc=0:d=${f(p.dur)}:s=48000:c=stereo[a${i}]`);
      }
    }
  });

  if (!blends) {
    const ins = pieces.map((_, i) => (keepAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
    const outs = keepAudio ? "[cv][aout]" : "[cv]";
    lines.push(`${ins}concat=n=${n}:v=1:a=${keepAudio ? 1 : 0}${outs}`);
  } else {
    // Fold the pieces in one by one: a plain cut with concat, a transition with xfade/acrossfade
    // (it starts `dur` before the end of the picture so far, which is where the piece's outStart is).
    let v = "[v0]";
    let a = "[a0]";
    let length = pieces[0]!.outEnd - pieces[0]!.outStart;
    for (let i = 1; i < n; i++) {
      const last = i === n - 1;
      const nv = last ? "[cv]" : `[xv${i}]`;
      const na = last ? "[aout]" : `[xa${i}]`;
      const t = pieces[i]!.transition;
      if (!t) {
        lines.push(`${v}[v${i}]concat=n=2:v=1:a=0${nv}`);
        if (keepAudio) lines.push(`${a}[a${i}]concat=n=2:v=0:a=1${na}`);
      } else {
        lines.push(`${v}[v${i}]xfade=transition=${XFADE[t.type]}:duration=${g(t.dur)}:offset=${g(length - t.dur)}${nv}`);
        if (keepAudio) lines.push(`${a}[a${i}]acrossfade=d=${g(t.dur)}${na}`);
      }
      length += pieces[i]!.outEnd - pieces[i]!.outStart - (t?.dur ?? 0);
      v = nv;
      a = na;
    }
  }
  lines.push(`[cv]${gradeFilter(grade)}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[vout]`);
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
    opts.draft ? "ultrafast" : "veryfast",
    "-crf",
    opts.draft ? "23" : "16",
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
