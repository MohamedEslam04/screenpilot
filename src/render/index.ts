import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { clicksOf, readEvents } from "../record/events.js";
import { lintStoryboard, loadStoryboard } from "../storyboard/load.js";
import type { Storyboard } from "../storyboard/schema.js";
import { buildTimeline, planNarrationHolds, type Timeline } from "../storyboard/timeline.js";
import { run } from "../util/exec.js";
import { ffmpegFilterScriptFlag, probeVideo, type VideoInfo } from "../util/media.js";
import { synthesizeLines } from "../voice/index.js";
import { buildCutArgs, buildCutFilter } from "./cut.js";
import { renderHtml } from "./html.js";
import { buildPlan, type RenderPlan } from "./plan.js";
import { CACHE_DIR } from "../brand.js";

const require = createRequire(import.meta.url);

export interface PrepareOptions {
  /** Where the HyperFrames project goes. Default: <storyboard dir>/<name>.build */
  buildDir?: string;
  log?: (msg: string) => void;
}

export interface Prepared {
  buildDir: string;
  plan: RenderPlan;
  timeline: Timeline;
  source: VideoInfo;
  warnings: string[];
  autoHolds: { at: number; dur: number }[];
}

export async function prepareBuild(storyboardPath: string, opts: PrepareOptions = {}): Promise<Prepared> {
  const log = opts.log ?? (() => {});
  const { sb, baseDir, path } = await loadStoryboard(storyboardPath);
  const sourcePath = resolve(baseDir, sb.source);
  if (!existsSync(sourcePath)) throw new Error(`Source video not found: ${sourcePath}`);
  const source = await probeVideo(sourcePath);
  const warnings = lintStoryboard(sb, source.duration);

  const buildDir = resolve(opts.buildDir ?? join(baseDir, `${basename(path, extname(path))}.build`));
  await mkdir(join(buildDir, "voice"), { recursive: true });

  // 1. Voice: real durations decide the pacing.
  log(`voice: ${sb.narration.length} line(s)`);
  const clips = await synthesizeLines(
    sb.voice.provider,
    sb.narration.map((l) => ({ text: l.text, voice: l.voice ?? sb.voice.name, rate: sb.voice.rate })),
    join(baseDir, CACHE_DIR, "voice"),
  );
  const narration = await Promise.all(
    sb.narration.map(async (l, i) => {
      const clip = clips[i]!;
      const src = `voice/${basename(clip.file)}`;
      await copyFile(clip.file, join(buildDir, src));
      return { ...clip, at: l.at, caption: l.caption ?? sb.voice.subtitles, src };
    }),
  );

  // 2. Timeline, with freezes so narration never overlaps.
  const offset = sb.intro?.dur ?? 0;
  // Chapter cards are holds too, so later times shift and narration holds keep working.
  const cardHolds = sb.cards.map((c, card) => ({ at: c.at, dur: c.dur, card }));
  const userHolds = [...sb.holds, ...cardHolds];
  const base = { segments: sb.segments, holds: userHolds, sourceDuration: source.duration, offset };
  const autoHolds = planNarrationHolds({
    ...base,
    gap: sb.voice.gap,
    lines: narration.map((l) => ({ at: l.at, duration: l.duration })),
  });
  const timeline = buildTimeline({ ...base, holds: [...userHolds, ...autoHolds] });
  for (const h of timeline.ignoredHolds) {
    warnings.push(
      h.card !== undefined
        ? `cards[${h.card}] at ${h.at}s is cut out (outside every segment) and was dropped`
        : `hold at ${h.at}s is outside every segment and was ignored`,
    );
  }
  for (const l of narration) {
    if (timeline.toOutput(l.at) === null) warnings.push(`narration at ${l.at}s falls in a cut region and was dropped`);
  }

  // 3. Cut the recording (cached on source + pieces).
  const keepAudio = sb.keepSourceAudio && source.hasAudio;
  await cutVideo(sourcePath, buildDir, timeline, sb, source, keepAudio, log);

  // 4. Events → click ripples.
  let clicks: { t: number; x: number; y: number }[] = [];
  if (sb.events) {
    const eventsPath = resolve(baseDir, sb.events);
    if (existsSync(eventsPath)) clicks = clicksOf(await readEvents(eventsPath));
    else warnings.push(`events file not found: ${eventsPath}`);
  }

  // 5. Music.
  let musicSrc: string | undefined;
  if (sb.music) {
    const m = resolve(baseDir, sb.music.src);
    if (existsSync(m)) {
      musicSrc = `music${extname(m)}`;
      await copyFile(m, join(buildDir, musicSrc));
    } else warnings.push(`music file not found: ${m}`);
  }

  // 6. Composition.
  const plan = buildPlan({
    sb,
    timeline,
    editedSrc: "edited.mp4",
    editedHasAudio: keepAudio,
    source,
    narration,
    clicks,
    musicSrc,
  });
  await copyFile(require.resolve("gsap/dist/gsap.min.js"), join(buildDir, "gsap.min.js"));
  await writeFile(join(buildDir, "index.html"), renderHtml(plan, { gsapSrc: "gsap.min.js" }));
  await writeFile(
    join(buildDir, "hyperframes.json"),
    JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2),
  );
  await writeFile(join(buildDir, "plan.json"), JSON.stringify({ plan, autoHolds, warnings }, null, 2));
  log(`composition: ${buildDir}/index.html (${plan.duration.toFixed(2)}s)`);

  return { buildDir, plan, timeline, source, warnings, autoHolds };
}

async function cutVideo(
  sourcePath: string,
  buildDir: string,
  timeline: Timeline,
  sb: Storyboard,
  source: VideoInfo,
  keepAudio: boolean,
  log: (msg: string) => void,
): Promise<void> {
  const filter = buildCutFilter({
    pieces: timeline.pieces,
    fps: sb.output.fps,
    sourceDuration: source.duration,
    keepAudio,
  });
  const st = await stat(sourcePath);
  const key = createHash("sha1").update(`${sourcePath}|${st.size}|${st.mtimeMs}|${filter}`).digest("hex");
  const out = join(buildDir, "edited.mp4");
  const keyFile = join(buildDir, "edited.key");
  if (existsSync(out) && existsSync(keyFile) && (await readFile(keyFile, "utf8")) === key) {
    log("cut: unchanged, reusing edited.mp4");
    return;
  }
  log(`cut: ${timeline.pieces.length} piece(s) -> ${timeline.videoDuration.toFixed(2)}s`);
  const filterPath = join(buildDir, "cut.filter");
  await writeFile(filterPath, filter);
  await run(
    "ffmpeg",
    buildCutArgs(
      { source: sourcePath, output: out, pieces: timeline.pieces, fps: sb.output.fps, sourceDuration: source.duration, keepAudio },
      filterPath,
      await ffmpegFilterScriptFlag(),
    ),
  );
  await writeFile(keyFile, key);
}

export interface RenderOptions extends PrepareOptions {
  output?: string;
  quality?: "draft" | "looks" | "delivery";
  /** Lossless frame extraction; sharper UI text, slower. */
  pngFrames?: boolean;
  /** Parallel headless Chrome renderers (default 2). */
  workers?: number;
}

export interface RenderResult extends Prepared {
  output: string;
}

export function hyperframesBin(): string {
  const pkg = require.resolve("hyperframes/package.json");
  return join(dirname(pkg), "bin", "hyperframes.mjs");
}

export function hyperframesEnv(): NodeJS.ProcessEnv {
  return { HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", HYPERFRAMES_SKIP_SKILLS: "1" };
}

export async function renderStoryboard(storyboardPath: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareBuild(storyboardPath, opts);
  const output = resolve(
    opts.output ?? join(dirname(resolve(storyboardPath)), `${basename(storyboardPath, extname(storyboardPath))}.mp4`),
  );
  await mkdir(dirname(output), { recursive: true });
  log(`render: ${output} (${opts.quality ?? "looks"})`);
  await run(
    process.execPath,
    [
      hyperframesBin(),
      "render",
      prepared.buildDir,
      "-o",
      output,
      "-q",
      opts.quality ?? "looks",
      "--video-frame-format",
      opts.pngFrames ? "png" : "auto",
      // Each worker is a headless Chrome (~250 MB+); "auto" can starve a desktop that is also running OBS and browsers.
      "--workers",
      String(opts.workers ?? 2),
      "--quiet",
    ],
    { env: hyperframesEnv() },
  );
  return { ...prepared, output };
}

/** Start (or reuse) the HyperFrames Studio preview for a prepared build. */
export async function startPreview(buildDir: string): Promise<string> {
  const { stdout, stderr } = await run(process.execPath, [hyperframesBin(), "preview", "--background", buildDir], {
    env: hyperframesEnv(),
  });
  return (stdout + stderr).trim();
}
