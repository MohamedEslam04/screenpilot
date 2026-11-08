// Spike for plans/2026-11-08-auto-chunked-render-cache.md, Task 1 (go/no-go):
// is a storyboard rendered in two output-time windows and joined with concatParts
// equivalent to a one-piece render? Not shipped; run with
//   pnpm exec tsx scripts/spike-chunks.ts <work-dir> <src.mp4> <sb.json> <quality> [clean|straddle|tween|all]
// Measures: frame count and stream durations, per-frame SSIM (mean, min, worst
// frames), audio at the join (gaps, jumps, level, chirp frequency to see whether
// the music restarts), keyframe at the join, decode errors. Then tries two audio
// fixes (re-encode the audio across the join; audio taken from the whole render).
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { concatParts, probePart, type OutputSize } from "../src/sequence/concat.js";
import { renderStoryboard } from "../src/render/index.js";
import { run } from "../src/util/exec.js";

const [workArg, srcArg, sbArg, qualityArg = "draft", variantArg = "both"] = process.argv.slice(2);
if (!workArg || !srcArg || !sbArg) throw new Error("usage: spike-chunks.ts <work-dir> <src.mp4> <sb.json> <quality> [clean|straddle|tween|all]");
const quality = qualityArg as "draft" | "looks" | "delivery";
const JOIN = 20;
const log = (m: string) => console.error(m);

type Sb = Record<string, unknown> & { zooms: Record<string, number>[]; music?: Record<string, unknown> };

async function makeMusic(file: string) {
  // A chirp (200 Hz rising 40 Hz per second) so the pitch at a time tells where in the file we are:
  // a restart at 20 s would drop from ~1000 Hz back to ~200 Hz.
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i",
    "aevalsrc=0.5*sin(2*PI*(200*t+20*t*t)):s=48000:d=45:c=stereo", "-c:a", "pcm_s16le", file,
  ]);
}

async function prepare(dir: string, variant: "clean" | "straddle" | "tween") {
  await mkdir(dir, { recursive: true });
  await copyFile(srcArg!, join(dir, "src.mp4"));
  await makeMusic(join(dir, "music.wav"));
  const sb = JSON.parse(await readFile(sbArg!, "utf8")) as Sb;
  // The bench storyboard has a zoom at exactly 20 s; replace it.
  sb.zooms = sb.zooms.filter((z) => z.at !== 20);
  if (variant === "clean") sb.zooms.push({ at: 14, dur: 3, x: 0.7, y: 0.6, scale: 2 }, { at: 30, dur: 3, x: 0.4, y: 0.4, scale: 1.8 });
  else if (variant === "straddle") sb.zooms.push({ at: 18, dur: 4, x: 0.7, y: 0.6, scale: 2 }); // held 18..22, straddles 20 (camera moves are 17.4..18 and 22..22.6)
  else sb.zooms.push({ at: 20.3, dur: 3, x: 0.7, y: 0.6, scale: 2 }); // the zoom-in move itself runs 19.7..20.3, so a camera tween straddles 20
  sb.music = { src: "music.wav", volume: 0.5, fadeIn: 1, fadeOut: 2 };
  const path = join(dir, "sb.json");
  await writeFile(path, JSON.stringify(sb, null, 2));
  return path;
}

interface Probe {
  frames: number;
  vDur: number;
  aDur: number;
  aCodec: string;
  rate: number;
  vStart: number;
  aStart: number;
}
async function probe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,nb_read_frames,duration,sample_rate,start_time", "-of", "json", file,
  ]);
  const s = (JSON.parse(stdout) as { streams: Record<string, string>[] }).streams;
  const v = s.find((x) => x.codec_type === "video")!;
  const a = s.find((x) => x.codec_type === "audio");
  return { frames: Number(v.nb_read_frames), vDur: Number(v.duration), aDur: a ? Number(a.duration) : NaN, aCodec: a?.codec_name ?? "none", rate: Number(a?.sample_rate ?? 0), vStart: Number(v.start_time), aStart: Number(a?.start_time ?? NaN) };
}

async function ssim(a: string, b: string, statsFile: string, fps: number) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", `[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file=${statsFile}`, "-f", "null", "-"]);
  const mean = Number(/SSIM Y:.* All:([0-9.]+)/.exec(stderr)?.[1] ?? NaN);
  const rows = (await readFile(statsFile, "utf8")).trim().split("\n").map((l) => ({
    n: Number(/n:(\d+)/.exec(l)![1]),
    all: Number(/All:([0-9.]+)/.exec(l)![1]),
  }));
  const min = rows.reduce((m, r) => (r.all < m.all ? r : m), rows[0]!);
  const meanOfFrames = rows.reduce((s, r) => s + r.all, 0) / rows.length;
  const near = rows.filter((r) => r.n >= JOIN * fps - 3 && r.n <= JOIN * fps + 4).map((r) => `${r.n}:${r.all.toFixed(4)}`);
  const below99 = rows.filter((r) => r.all < 0.99).length;
  const below95 = rows.filter((r) => r.all < 0.95).length;
  return { frames: rows.length, mean, meanOfFrames, min: min.all, minFrame: min.n, below99, below95, aroundJoin: near.join(" ") };
}

/** Whole file's audio as stereo float samples at 48 kHz. */
async function pcm(file: string): Promise<Float32Array> {
  const { spawn } = await import("node:child_process");
  return new Promise((res, rej) => {
    const c = spawn("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "-"], { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    c.stdout.on("data", (d: Buffer) => chunks.push(d));
    c.on("close", () => {
      const b = Buffer.concat(chunks);
      res(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
    c.on("error", rej);
  });
}

function audioReport(whole: Float32Array, joined: Float32Array, wp: Probe, jp: Probe) {
  const SR = 48000;
  const left = (x: Float32Array) => {
    const o = new Float32Array(x.length / 2);
    for (let i = 0; i < o.length; i++) o[i] = x[i * 2]!;
    return o;
  };
  const w = left(whole);
  const j = left(joined);
  const rms = (x: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += x[i]! * x[i]!;
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const diffRms = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += (w[i]! - j[i]!) ** 2;
    return Math.sqrt(s / Math.max(1, b - a));
  };
  // Zero crossings -> frequency in a span.
  const freq = (x: Float32Array, a: number, b: number) => {
    let c = 0;
    for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 !== x[i]! < 0) c++;
    return (c / 2) / ((b - a) / SR);
  };
  const jn = JOIN * SR;
  // Largest sample-to-sample jump and longest near-silent run within +-50 ms of the join.
  const around = (x: Float32Array) => {
    let maxStep = 0;
    let maxStep2 = 0;
    let run = 0;
    let longest = 0;
    for (let i = jn - SR * 0.05; i < jn + SR * 0.05; i++) {
      maxStep = Math.max(maxStep, Math.abs(x[i]! - x[i - 1]!));
      maxStep2 = Math.max(maxStep2, Math.abs(x[i]! - 2 * x[i - 1]! + x[i - 2]!)); // a pure tone has a smooth second difference; a splice does not
      if (Math.abs(x[i]!) < 1e-4) run++;
      else {
        longest = Math.max(longest, run);
        run = 0;
      }
    }
    return { maxStep: +maxStep.toFixed(5), maxStep2: +maxStep2.toFixed(5), longestSilentRunSamples: Math.max(longest, run) };
  };
  // Alignment: lag (samples, +- 4096) of joined vs whole minimizing the difference over a 0.5 s span starting at `at` seconds.
  const lagOf = (at: number) => {
    let best = 0;
    let bestE = Infinity;
    const a0 = Math.round(at * SR);
    for (let lag = -4096; lag <= 4096; lag++) {
      let s = 0;
      for (let i = a0; i < a0 + 24000; i += 3) s += (w[i]! - (j[i + lag] ?? 0)) ** 2;
      if (s < bestE) {
        bestE = s;
        best = lag;
      }
    }
    return best;
  };
  const n = Math.min(w.length, j.length);
  return {
    samples: { whole: w.length, joined: j.length, diff: j.length - w.length },
    rmsWholeOverall: +rms(w, 0, n).toFixed(5),
    diffRmsOverall: +diffRms(0, n).toFixed(5),
    diffRmsBefore: +diffRms(5 * SR, 19 * SR).toFixed(5),
    diffRmsAfter: +diffRms(21 * SR, 35 * SR).toFixed(5),
    diffRmsAt20: +diffRms(jn - 4800, jn + 4800).toFixed(5),
    rmsAt20: { whole: +rms(w, jn - 4800, jn + 4800).toFixed(5), joined: +rms(j, jn - 4800, jn + 4800).toFixed(5) },
    chirpHzAt20_0to20_1: { whole: Math.round(freq(w, jn, jn + 4800)), joined: Math.round(freq(j, jn, jn + 4800)) },
    chirpHzAt20_5: { whole: Math.round(freq(w, jn + 24000, jn + 28800)), joined: Math.round(freq(j, jn + 24000, jn + 28800)) },
    // Lag of the decoded audio (joined sample i+lag = whole sample i) plus the stream start times give the
    // audio-vs-video shift relative to the one-piece render, in ms (0 = same sync as whole; + = audio late).
    ...Object.fromEntries(
      [2, 10, 30, 38].map((t) => {
        const lag = lagOf(t);
        const shiftMs = ((jp.aStart + lag / SR - jp.vStart) - (wp.aStart - wp.vStart)) * 1000;
        return [`at${t}s`, { lagSamples: lag, avSyncShiftMs: +shiftMs.toFixed(1) }];
      }),
    ),
    aroundJoin50ms: { whole: around(w), joined: around(j) },
  };
}

async function astats(file: string) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", "19.9", "-t", "0.2", "-i", file, "-vn", "-af", "astats=metadata=0:reset=0", "-f", "null", "-"]);
  const pick = (k: string) => new RegExp(`Overall[\\s\\S]*?${k}: (\\S+)`).exec(stderr)?.[1];
  return { rms_dB: pick("RMS level dB"), peak_dB: pick("Peak level dB"), maxDiff: pick("Max difference"), meanDiff: pick("Mean difference") };
}

/** Every video keyframe packet (pts) of the file: shows where GOPs start, in particular at the join. */
async function keyframes(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file]);
  return stdout.trim().split("\n").filter((l) => l.includes("K")).map((l) => l.split(",")[0]!);
}
async function firstFrame(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v", "-read_intervals", "%+#1", "-show_entries", "frame=pts_time,key_frame,pict_type", "-of", "csv=p=0", file]);
  return stdout.trim();
}
async function decodeErrors(file: string) {
  const { stderr } = await run("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]).catch((e: Error) => ({ stderr: `FAILED: ${e.message}` }));
  return stderr.trim() || "none";
}
async function timestampsMonotonic(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "packet=stream_index,dts_time,pts_time", "-of", "csv=p=0", file]);
  const last = new Map<string, number>();
  let backwards = 0;
  for (const l of stdout.trim().split("\n")) {
    const [idx, dts] = l.split(",");
    const t = Number(dts);
    if (!Number.isFinite(t)) continue;
    if (t < (last.get(idx!) ?? -Infinity)) backwards++;
    last.set(idx!, t);
  }
  return { backwardsDtsPackets: backwards };
}

async function muxAudio(video: string, audio: string, out: string) {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", out]);
}

/** Render unless the file exists and SPIKE_REUSE=1 (renders are slow, analysis is what changes). */
async function render(sb: string, output: string, buildDir: string, window?: { from: number; to?: number }) {
  if (process.env.SPIKE_REUSE === "1" && existsSync(output)) return;
  await renderStoryboard(sb, { quality, output, buildDir, window, log });
}

async function variant(root: string, name: "clean" | "straddle" | "tween") {
  const dir = join(root, `${name}-${quality}`);
  const sb = await prepare(dir, name);
  const whole = join(dir, "whole.mp4");
  const w1 = join(dir, "w1.mp4");
  const w2 = join(dir, "w2.mp4");
  const joined = join(dir, "joined.mp4");
  const t0 = Date.now();
  await render(sb, whole, join(dir, "whole.build"));
  await render(sb, join(dir, "whole2.mp4"), join(dir, "whole.build")); // same render again: the noise floor of the comparison
  await render(sb, w1, join(dir, "w1.build"), { from: 0, to: JOIN });
  await render(sb, w2, join(dir, "w2.build"), { from: JOIN, to: 40 });
  log(`rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s (noisy, do not use)`);
  const size: OutputSize = { width: 1920, height: 1080, fps: 30 };
  const parts = [await probePart(w1), await probePart(w2)];
  const j = await concatParts(parts, joined, size, { workDir: dir, quality, log });

  const report: Record<string, unknown> = { variant: name, quality, joinMode: j.mode };
  report.parts = { w1: await probe(w1), w2: await probe(w2) };
  report.partPcmSamplesPerChannel = { w1: (await pcm(w1)).length / 2, w2: (await pcm(w2)).length / 2, whole: (await pcm(whole)).length / 2 };
  report.whole = await probe(whole);
  report.joined = await probe(joined);
  const fps = (report.whole as Probe).frames / (report.whole as Probe).vDur;
  report.outputFps = fps;
  report.ssimWholeVsWhole2_noiseFloor = await ssim(whole, join(dir, "whole2.mp4"), join(dir, "ssim-base.txt"), fps);
  report.ssimWholeVsJoined = await ssim(whole, joined, join(dir, "ssim.txt"), fps);
  const wholePcm = await pcm(whole);
  report.audioCopyJoin = audioReport(wholePcm, await pcm(joined), report.whole as Probe, report.joined as Probe);
  report.astats19_9to20_1 = { whole: await astats(whole), joined: await astats(joined) };
  report.joinedKeyframePts = await keyframes(joined);
  report.firstFrameOfW2 = await firstFrame(w2);
  report.decodeErrorsJoined = await decodeErrors(joined);
  report.timestamps = await timestampsMonotonic(joined);

  // Video-only stream copy join (starts at 0: the audio priming does not shift it).
  const list = join(dir, "concat-v.txt");
  await writeFile(list, [w1, w2].map((f) => `file '${f}'`).join("\n") + "\n");
  const videoOnly = join(dir, "joined-video-only.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-an", "-c", "copy", videoOnly]);
  report.videoOnlyJoin = { probe: await probe(videoOnly) };
  const alt = async (name: string, audioFile: string, extra: Record<string, unknown> = {}) => {
    const out = join(dir, `${name}.mp4`);
    await muxAudio(videoOnly, audioFile, out);
    const pj = await probe(out);
    report[name] = {
      probe: pj,
      audio: audioReport(wholePcm, await pcm(out), report.whole as Probe, pj),
      astats: await astats(out),
      decodeErrors: await decodeErrors(out),
      ssimWholeVsThis: (await ssim(whole, out, join(dir, `ssim-${name}.txt`), fps)),
      ...extra,
    };
  };
  // Alt 1: video copy, audio of both parts decoded, each trimmed/padded to its video length, joined and AAC-encoded ONCE.
  const audioRe = join(dir, "audio-reenc.m4a");
  const d = (p: { duration: number }) => p.duration.toFixed(3);
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", w1, "-i", w2, "-filter_complex",
    `[0:a]aresample=48000:async=1,apad,atrim=duration=${d(parts[0]!)},asetpts=PTS-STARTPTS[a0];` +
      `[1:a]aresample=48000:async=1,apad,atrim=duration=${d(parts[1]!)},asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[a]`,
    "-map", "[a]", "-c:a", "aac", "-b:a", "192k", audioRe,
  ]);
  await alt("alt1_videoCopy_audioReencodedOnce", audioRe);
  // Alt 2: video copy, audio of the one-piece render (upper bound: audio rendered once in one piece).
  await alt("alt2_videoCopy_wholeAudio", whole);

  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const root = workArg!;
  await mkdir(root, { recursive: true });
  for (const v of ["clean", "straddle", "tween"] as const) if (variantArg === "both" || variantArg === "all" || variantArg === v) await variant(root, v);
}
void main();
