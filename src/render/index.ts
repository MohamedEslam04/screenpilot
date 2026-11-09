import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { clicksOf, readEvents } from "../record/events.js";
import { lintTimeline } from "../storyboard/lint.js";
import { lintStoryboard, type LoadedStyle, loadStoryboard } from "../storyboard/load.js";
import type { Storyboard } from "../storyboard/schema.js";
import { buildTimeline, planNarrationHolds, type Timeline } from "../storyboard/timeline.js";
import { run } from "../util/exec.js";
import { writeAtomically } from "../util/partial.js";
import { withProcessScope } from "../util/proc.js";
import { makeTimer } from "../util/timing.js";
import { ffmpegFilterScriptFlag, probeVideo, type VideoInfo } from "../util/media.js";
import { externalClip } from "../voice/external.js";
import { synthesizeLines, type VoiceClip } from "../voice/index.js";
import { buildCutArgs, buildCutFilter } from "./cut.js";
import { draftFps } from "./draft.js";
import { renderHtml } from "./html.js";
import { formatPaths, type OutputFormat } from "./formats.js";
import { checkPosterAt, type ExtraFormat, exportExtras } from "./export.js";
import { overlayKind } from "./overlay.js";
import { type LoudnessTarget, normalizeLoudness } from "./loudness.js";
import { planMusicRange, prepareMusic } from "./music.js";
import { mixSfx, planSfx, sfxInput } from "./sfx.js";
import { type ChunkSources, chunkKey, planChunks, type Span, timelineBusy } from "./chunks.js";
import { joinChunks } from "./join.js";
import { type SubtitleFormat, writeSubtitles } from "./subtitles.js";
import { buildOutputTimeline, timelinePath, writeTimeline } from "./timeline.js";
import { buildPlan, type OverlayAsset, type RenderPlan } from "./plan.js";
import { partSuffix, type Window, windowPlan } from "./window.js";
import { estimateSeconds, formatDuration, recordSpeed, speedFile } from "./speed.js";
import { autoWorkers } from "./workers.js";
import { CACHE_DIR, cacheHome } from "../brand.js";
import { pruneCache, renderCacheLimit } from "./cache.js";
import { recordEvent } from "../history/index.js";
import { startJob } from "../history/jobs.js";

const require = createRequire(import.meta.url);

/** Print a render-time estimate only when the render is expected to take at least this long. */
const LONG_RENDER_SECONDS = 120;
/** Renders of shorter videos are not remembered: start-up time dominates and says little about long renders. */
const MIN_RECORDED_SECONDS = 5;

export interface PrepareOptions {
  /** Where the HyperFrames project goes. Default: <storyboard dir>/<name>.build */
  buildDir?: string;
  /** Build only this window (output seconds) for a fast review render. */
  window?: Window;
  /** Override the storyboard's output size (multi-format export); fps is kept. */
  size?: { width: number; height: number };
  /** Voice cache. Default: CACHE_DIR next to the storyboard */
  cacheDir?: string;
  log?: (msg: string) => void;
  /** Log how long each stage took (and show HyperFrames' own phase timings). */
  timings?: boolean;
  /** Draft build: faster, lighter cut. Set by renderStoryboard for `-q draft`. */
  draft?: boolean;
  /** A style file (see loadStyle): its theme is merged over the storyboard's. Names the default build dir and output. */
  style?: LoadedStyle;
}

export interface Prepared {
  buildDir: string;
  plan: RenderPlan;
  timeline: Timeline;
  source: VideoInfo;
  warnings: string[];
  autoHolds: { at: number; dur: number }[];
  /** Normalize the finished video to this loudness (storyboard audio.loudness). */
  loudness?: LoudnessTarget;
  /** What the build-dir files of the plan contain, for the chunk cache keys. */
  sources: ChunkSources;
  /** The storyboard's outro card, so timeline.json can tell it from the other cards. */
  outro?: { title: string; subtitle?: string };
}

/** Identity of a file's content for the chunk cache: name, size and modification time (as the sequence part keys). */
async function fileStamp(file: string): Promise<string> {
  if (!existsSync(file)) return `${basename(file)}:-`;
  const st = await stat(file);
  return `${basename(file)}:${st.size}:${st.mtimeMs}`;
}

export async function prepareBuild(storyboardPath: string, opts: PrepareOptions = {}): Promise<Prepared> {
  const log = opts.log ?? (() => {});
  const time = makeTimer(opts.timings, log);
  const { sb, baseDir, path } = await loadStoryboard(storyboardPath, { style: opts.style });
  if (opts.size) sb.output = { ...sb.output, ...opts.size };
  const sourcePath = resolve(baseDir, sb.source);
  if (!existsSync(sourcePath)) throw new Error(`Source video not found: ${sourcePath}`);
  const source = await time("probe", () => probeVideo(sourcePath));
  const warnings = lintStoryboard(sb, source.duration);

  const buildDir = resolve(opts.buildDir ?? join(baseDir, `${basename(path, extname(path))}${styleSuffix(opts.style)}${opts.window ? partSuffix(opts.window) : ""}.build`));
  await mkdir(join(buildDir, "voice"), { recursive: true });

  // 1. Voice: real durations decide the pacing.
  log(`voice: ${sb.narration.length} line(s)`);
  const clips = await time("voice", async () => {
    const lines = sb.narration.map((l) => ({ text: l.text, voice: l.voice ?? sb.voice.name, rate: sb.voice.rate }));
    // Lines with their own audio file skip the voice; the others are synthesized together.
    const spoken = sb.narration.flatMap((l, i) => (l.audio ? [] : [i]));
    const made = await synthesizeLines(sb.voice.provider, spoken.map((i) => lines[i]!), join(opts.cacheDir ?? join(baseDir, CACHE_DIR), "voice"));
    const all: VoiceClip[] = [];
    spoken.forEach((i, k) => (all[i] = made[k]!));
    for (const [i, l] of sb.narration.entries()) if (l.audio) all[i] = await externalClip(lines[i]!, resolve(baseDir, l.audio), i);
    return all;
  });
  // Build-dir copies get a new time on every build, so the chunk cache keys them by their originals.
  const files: Record<string, string> = {};
  const narration = await Promise.all(
    sb.narration.map(async (l, i) => {
      const clip = clips[i]!;
      // Ready-made files keep their extension but get a per-line name, so two "01.mp3" in different folders do not collide.
      const src = l.audio ? `voice/ext-${i}${extname(clip.file).toLowerCase()}` : `voice/${basename(clip.file)}`;
      await copyFile(clip.file, join(buildDir, src));
      files[src] = await fileStamp(clip.file);
      return { ...clip, at: l.at, caption: l.caption ?? sb.voice.subtitles, src, id: l.id ?? String(i) };
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
  warnings.push(...lintTimeline(sb, timeline));
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
  if (!keepAudio && sb.segments.some((s) => s.mute || (s.volume !== undefined && s.volume !== 1))) {
    warnings.push("segment volume/mute has no effect: the source audio is not kept (set keepSourceAudio: true and use a recording with sound)");
  }
  if (sb.audio?.denoise && !keepAudio) warnings.push("audio.denoise has no effect: the source audio is not kept (set keepSourceAudio: true and use a recording with sound)");
  await time("cut", () => cutVideo(sourcePath, buildDir, timeline, sb, source, keepAudio, !!opts.draft, log));

  // 4. Events → click ripples.
  let clicks: { t: number; x: number; y: number }[] = [];
  if (sb.events) {
    const eventsPath = resolve(baseDir, sb.events);
    if (existsSync(eventsPath)) {
      clicks = clicksOf(await readEvents(eventsPath));
    } else warnings.push(`events file not found: ${eventsPath}`);
  } else if (sb.sounds?.clicks) {
    warnings.push("sounds.clicks needs `events` (the events.jsonl from the recording); no click sounds were added");
  }

  // 4b. Sound effects: all of them mixed into one track.
  const total = round3(timeline.videoEnd + (sb.outro?.dur ?? 0));
  const sfxPlan = planSfx({ sb, timeline, clicks, duration: total });
  warnings.push(...sfxPlan.warnings);
  const sfxMix = await time("sfx", () => mixSfx(sfxPlan.hits, { baseDir, buildDir, duration: total, log }));
  warnings.push(...sfxMix.warnings);

  // 5. Music: straight into the composition, or prepared first for a loop, offset or from/to range.
  let musicSrc: string | undefined;
  let musicClip: { start: number; duration: number } | undefined;
  if (sb.music) {
    const m = resolve(baseDir, sb.music.src);
    if (existsSync(m)) {
      const range = planMusicRange(sb.music, timeline, total);
      warnings.push(...range.warnings);
      if (range.custom) {
        const prepared = await time("music", () => prepareMusic(sb.music!, m, range, { buildDir, log }));
        warnings.push(...prepared.warnings);
        if (prepared.file) {
          musicSrc = prepared.file;
          musicClip = { start: range.start, duration: prepared.length };
          // Its cache key names the source file and the filter that made it.
          files[musicSrc] = await readFile(join(buildDir, "music-track.key"), "utf8").catch(() => fileStamp(m));
        }
      } else {
        musicSrc = `music${extname(m)}`;
        await copyFile(m, join(buildDir, musicSrc));
        files[musicSrc] = await fileStamp(m);
      }
    } else warnings.push(`music file not found: ${m}`);
  }

  // 5b. Overlay images and videos.
  await mkdir(join(buildDir, "overlays"), { recursive: true });
  const overlays: (OverlayAsset | undefined)[] = [];
  for (const [i, o] of sb.overlays.entries()) {
    const file = resolve(baseDir, o.src);
    const kind = overlayKind(o.src);
    if (!kind) warnings.push(`overlays[${i}] "${o.src}" is not a known image or video type and was skipped`);
    else if (!existsSync(file)) warnings.push(`overlays[${i}] file not found: ${file}`);
    if (!kind || !existsSync(file)) {
      overlays.push(undefined);
      continue;
    }
    const src = `overlays/${i}${extname(file).toLowerCase()}`;
    await copyFile(file, join(buildDir, src));
    files[src] = await fileStamp(file);
    if (kind === "image") overlays.push({ src, kind });
    else {
      const info = await probeVideo(file);
      overlays.push({ src, kind, duration: info.duration, hasAudio: info.hasAudio });
    }
  }

  // 6. Composition.
  const fullPlan = buildPlan({
    sb,
    timeline,
    editedSrc: "edited.mp4",
    editedHasAudio: keepAudio,
    source,
    narration,
    clicks,
    musicSrc,
    musicClip,
    overlays,
    sfxSrc: sfxMix.file,
  });
  const plan = opts.window ? windowPlan(fullPlan, opts.window) : fullPlan;
  await copyFile(require.resolve("gsap/dist/gsap.min.js"), join(buildDir, "gsap.min.js"));
  await writeFile(join(buildDir, "index.html"), renderHtml(plan, { gsapSrc: "gsap.min.js" }));
  await writeFile(
    join(buildDir, "hyperframes.json"),
    JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2),
  );
  await writeFile(join(buildDir, "plan.json"), JSON.stringify({ plan, autoHolds, warnings }, null, 2));
  log(`composition: ${buildDir}/index.html (${plan.duration.toFixed(2)}s)`);

  // Everything the cut depends on except the pieces (see cutVideo), so a chunk can key on the pieces it shows.
  const cut = [await fileStamp(sourcePath), source.duration, sb.output.fps, keepAudio, !!sb.audio?.denoise, JSON.stringify(sb.theme.grade ?? null), !!opts.draft].join("|");
  const sources: ChunkSources = { files, video: { src: "edited.mp4", cut, pieces: timeline.pieces } };
  if (sfxMix.file) {
    const sound = async (src: string) => {
      const file = sfxInput(src, baseDir)?.file;
      return file ? fileStamp(file) : src;
    };
    sources.sfx = { src: sfxMix.file, hits: await Promise.all(sfxPlan.hits.map(async (h) => ({ at: h.at, volume: h.volume, sound: await sound(h.src) }))) };
  }

  const outro = sb.outro && { title: sb.outro.title, ...(sb.outro.subtitle !== undefined ? { subtitle: sb.outro.subtitle } : {}) };
  return { buildDir, plan, timeline, source, warnings, autoHolds, loudness: sb.audio?.loudness, sources, ...(outro ? { outro } : {}) };
}

/** ".<style>" in default build dir and output names, so styles never overwrite each other; nothing without a style. */
const styleSuffix = (style?: LoadedStyle) => (style ? `.${style.name}` : "");

const round3 = (n: number) => Math.round(n * 1000) / 1000;

async function cutVideo(
  sourcePath: string,
  buildDir: string,
  timeline: Timeline,
  sb: Storyboard,
  source: VideoInfo,
  keepAudio: boolean,
  draft: boolean,
  log: (msg: string) => void,
): Promise<void> {
  const filter = buildCutFilter({
    pieces: timeline.pieces,
    fps: sb.output.fps,
    sourceDuration: source.duration,
    keepAudio,
    denoise: !!sb.audio?.denoise,
    grade: sb.theme.grade,
  });
  const st = await stat(sourcePath);
  const key = createHash("sha1").update(`${sourcePath}|${st.size}|${st.mtimeMs}|${filter}|${draft ? "draft" : "full"}`).digest("hex");
  const out = join(buildDir, "edited.mp4");
  const keyFile = join(buildDir, "edited.key");
  if (existsSync(out) && existsSync(keyFile) && (await readFile(keyFile, "utf8")) === key) {
    log("cut: unchanged, reusing edited.mp4");
    return;
  }
  log(`cut: ${timeline.pieces.length} piece(s) -> ${timeline.videoDuration.toFixed(2)}s`);
  const filterPath = join(buildDir, "cut.filter");
  await writeFile(filterPath, filter);
  // An aborted cut leaves a half-written edited.mp4: no key may vouch for it.
  await rm(keyFile, { force: true });
  await run(
    "ffmpeg",
    buildCutArgs(
      { source: sourcePath, output: out, pieces: timeline.pieces, fps: sb.output.fps, sourceDuration: source.duration, keepAudio, draft },
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
  /** Parallel headless Chrome renderers (default: from CPU cores and free memory, see autoWorkers). */
  workers?: number;
  /** Write subtitle files (from the narration) next to the video. */
  subtitles?: SubtitleFormat[];
  /** Also make a GIF, a WebM or a poster frame from the finished video. */
  also?: ExtraFormat[];
  /** Poster frame time, in OUTPUT seconds (default: a quarter of the way in). */
  posterAt?: number;
  /** false: never split into cached chunks (`--no-chunks`). Default: chunks for outputs of CHUNK_MIN_OUTPUT seconds or more. */
  chunks?: boolean;
  /** Preferred chunk length in seconds (`--chunk-seconds`, at least MIN_CHUNK_SECONDS). Default 180. */
  chunkSeconds?: number;
  /** false: leave no history line and no live-job file (parts of a sequence, the setup warm-up). */
  history?: boolean;
  /** Told which chunk is rendering, for the live-job file. */
  onProgress?: (step: { label: string; index: number; total: number }) => void;
  /** Aborts the render (an MCP request cancelled): its whole process tree is killed. abortAll does the same for every render. */
  signal?: AbortSignal;
}

/** Outputs (or --from/--to windows) shorter than this render in one piece, exactly as before chunks existed. */
export const CHUNK_MIN_OUTPUT = 300;
const MIN_CHUNK_SECONDS = 10;

export interface RenderResult extends Prepared {
  output: string;
  /** Subtitle and extra files that were written next to the video. */
  files: string[];
  /** `<output>.timeline.json`: when each narration line and card is on screen in the finished video. */
  timelineFile: string;
}

export function hyperframesBin(): string {
  const pkg = require.resolve("hyperframes/package.json");
  return join(dirname(pkg), "bin", "hyperframes.mjs");
}

/** Where HyperFrames keeps extracted frames: our own folder under the user cache dir (not tmpfs) unless the user chose one. */
export function extractCacheDir(): string {
  return process.env.HYPERFRAMES_EXTRACT_CACHE_DIR || join(cacheHome(), "extract");
}

export function hyperframesEnv(): NodeJS.ProcessEnv {
  return {
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_EXTRACT_CACHE_DIR: extractCacheDir(),
  };
}

/** Render a storyboard. Also leaves a live-job file while it runs and a history line when it ends (unless `history: false`). */
export async function renderStoryboard(storyboardPath: string, opts: RenderOptions = {}): Promise<RenderResult> {
  if (opts.history === false) return renderStoryboardNow(storyboardPath, opts);
  const quality = opts.quality ?? "looks";
  const path = resolve(storyboardPath);
  const job = startJob({ kind: "render", path, quality });
  const started = performance.now();
  try {
    const r = await renderStoryboardNow(storyboardPath, {
      ...opts,
      onProgress: (step) => {
        job.update(step);
        opts.onProgress?.(step);
      },
    });
    await recordEvent({ kind: "render", status: "ok", path, output: r.output, durationSec: r.plan.duration, quality, wallSeconds: round3((performance.now() - started) / 1000) });
    return r;
  } catch (err) {
    await recordEvent({ kind: "render", status: "failed", path, quality, wallSeconds: round3((performance.now() - started) / 1000), error: (err as Error).message.slice(0, 500) });
    throw err;
  } finally {
    job.end();
  }
}

function renderStoryboardNow(storyboardPath: string, opts: RenderOptions): Promise<RenderResult> {
  // Every child (HyperFrames, its Chrome, ffmpeg) is tracked: abortAll, opts.signal or our own exit kills the whole tree.
  return withProcessScope(() => renderTracked(storyboardPath, opts), { signal: opts.signal });
}

async function renderTracked(storyboardPath: string, opts: RenderOptions): Promise<RenderResult> {
  const log = opts.log ?? (() => {});
  const draft = opts.quality === "draft";
  checkPosterAt(opts.posterAt);
  if (opts.chunkSeconds !== undefined && !(opts.chunkSeconds >= MIN_CHUNK_SECONDS)) {
    throw new Error(`--chunk-seconds must be at least ${MIN_CHUNK_SECONDS} (got ${opts.chunkSeconds})`);
  }
  const prepared = await prepareBuild(storyboardPath, { ...opts, draft });
  const output = resolve(
    opts.output ??
      join(dirname(resolve(storyboardPath)), `${basename(storyboardPath, extname(storyboardPath))}${styleSuffix(opts.style)}${opts.window ? partSuffix(opts.window) : ""}.mp4`),
  );
  await mkdir(dirname(output), { recursive: true });
  const workers = opts.workers ?? autoWorkers();
  // Keep our own extract cache under its cap (a cache the user pointed elsewhere is theirs to manage).
  if (!process.env.HYPERFRAMES_EXTRACT_CACHE_DIR) {
    const pruned = await pruneCache(extractCacheDir(), renderCacheLimit()).catch(() => undefined);
    if (pruned?.removed) log(`render cache: removed ${pruned.removed} old entr${pruned.removed === 1 ? "y" : "ies"} (${(pruned.freed / 2 ** 20).toFixed(0)} MB)`);
  }
  log(`render: ${output} (${opts.quality ?? "looks"}, ${workers} worker(s))`);
  const time = makeTimer(opts.timings, log);
  const quality = opts.quality ?? "looks";
  const hyperframes = (out: string) =>
    run(
      process.execPath,
      [
        hyperframesBin(),
        "render",
        prepared.buildDir,
        "-o",
        out,
        "-q",
        quality,
        "--video-frame-format",
        opts.pngFrames ? "png" : "auto",
        // Each worker is a headless Chrome; autoWorkers leaves cores and memory for a desktop that is also running OBS and browsers.
        "--workers",
        String(workers),
        // Draft: fewer frames to capture. Times are in seconds, so the video length does not change.
        ...(draft ? ["--fps", String(draftFps(prepared.plan.fps))] : []),
        // --timings shows HyperFrames' own phase timings, so drop --quiet then.
        ...(opts.timings ? [] : ["--quiet"]),
      ],
      { env: hyperframesEnv(), inherit: opts.timings },
    );
  const chunks = planRenderChunks(prepared, opts);
  // Seconds of video HyperFrames will really render (cached chunks cost nothing): the estimate and the speed record use them.
  const renderSeconds = chunks ? chunks.filter((c) => !c.cached).reduce((s, c) => s + c.end - c.start, 0) : prepared.plan.duration;
  if (chunks) log(`chunks: ${chunks.length} of about ${opts.chunkSeconds ?? 180} s, ${chunks.filter((c) => c.cached).length} unchanged`);
  // Only from measured renders of this quality; never a guess.
  const estimate = renderSeconds > 0 ? await estimateSeconds(speedFile(), quality, renderSeconds).catch(() => undefined) : undefined;
  if (estimate !== undefined && estimate >= LONG_RENDER_SECONDS) {
    log(`estimated ~${formatDuration(estimate)} (from your last ${quality} renders). Faster: -q draft, --workers max, --from/--to for a window`);
  }
  const renderStart = performance.now();
  // Written as <name>.partial.mp4 and renamed when complete: whoever watches the folder sees a playable file or none.
  await writeAtomically(output, async (partial) => {
    await time("render", async () => {
      if (chunks) await renderChunks(prepared, chunks, partial, hyperframes, log, opts.onProgress);
      else await hyperframes(partial);
    });
    if (prepared.loudness) {
      const target = prepared.loudness;
      await time("loudness", async () => {
        const r = await normalizeLoudness(partial, target);
        if (r.applied) log(`loudness: ${r.measured!.input_i} LUFS -> ${target.target} LUFS`);
        else prepared.warnings.push(`audio.loudness was not applied: ${r.reason}`);
      });
    }
  });
  // Only a render that finished: a failed or aborted one threw above and never gets here.
  // Very short clips (the setup warm-up, tiny windows) are dominated by browser start-up and would skew the estimate.
  if (renderSeconds >= MIN_RECORDED_SECONDS) {
    await recordSpeed(speedFile(), { quality, workers, outSeconds: round3(renderSeconds), wallSeconds: (performance.now() - renderStart) / 1000 }).catch(() => {});
  }
  const files: string[] = [];
  if (opts.subtitles?.length) files.push(...(await writeSubtitles(prepared.plan.subtitles, output, opts.subtitles)));
  if (opts.also?.length) files.push(...(await time("extras", () => exportExtras(output, opts.also!, { posterAt: opts.posterAt }))));
  for (const f of files) log(`wrote ${f}`);
  // The length the file really has (a short file next to a longer plan is what a stale timeline looks like later).
  const length = await probeVideo(output).then((v) => v.duration, () => prepared.plan.duration);
  const timelineFile = timelinePath(output);
  await writeTimeline(timelineFile, { ...buildOutputTimeline(prepared.plan, { outro: prepared.outro }), duration: round3(length) });
  log(`wrote ${timelineFile}`);
  return { ...prepared, output, files, timelineFile };
}

interface RenderChunk extends Span {
  file: string;
  cached: boolean;
}

/** Where the chunks of one quality live: draft and delivery never evict each other. */
const chunkDir = (buildDir: string, quality: string, png?: boolean) => join(buildDir, "chunks", `${quality}${png ? "-png" : ""}`);

/**
 * The chunks of a long render with their cache files, or undefined to render in one
 * piece (chunks off, output under CHUNK_MIN_OUTPUT, or no quiet point to cut at).
 * A chunk file is named by its key (chunkKey), so a chunk is reused wherever it
 * lands in the list, and a missing file is all "changed" means.
 */
function planRenderChunks(prepared: Prepared, opts: RenderOptions): RenderChunk[] | undefined {
  const { plan } = prepared;
  if (opts.chunks === false || plan.duration < CHUNK_MIN_OUTPUT) return undefined;
  const from = opts.window?.from ?? 0;
  const busy = timelineBusy(prepared.timeline).map((s) => ({ start: s.start - from, end: s.end - from }));
  const spans = planChunks(plan, { target: opts.chunkSeconds, busy });
  if (spans.length < 2) return undefined;
  const quality = opts.quality ?? "looks";
  const dir = chunkDir(prepared.buildDir, quality, opts.pngFrames);
  const render = [quality, opts.pngFrames ? "png" : "auto", `hyperframes ${require("hyperframes/package.json").version as string}`].join("|");
  return spans.map((s) => {
    const file = join(dir, `${chunkKey(plan, s, prepared.sources, render)}.mp4`);
    return { ...s, file, cached: existsSync(file) };
  });
}

/**
 * Render the changed chunks one after another (each is parallel inside), then join
 * them all. index.html holds one chunk's composition while it renders and the full
 * one again afterwards. A chunk is written under a temporary name and renamed when
 * it is complete, so a failed render keeps every finished chunk for the retry.
 */
async function renderChunks(
  prepared: Prepared,
  chunks: RenderChunk[],
  output: string,
  hyperframes: (out: string) => Promise<unknown>,
  log: (msg: string) => void,
  onProgress?: RenderOptions["onProgress"],
): Promise<void> {
  const index = join(prepared.buildDir, "index.html");
  const dir = dirname(chunks[0]!.file);
  await mkdir(dir, { recursive: true });
  const range = (c: Span) => `${round3(c.start)}-${round3(c.end)} s`;
  try {
    for (const [i, c] of chunks.entries()) {
      const label = `chunk ${i + 1}/${chunks.length}`;
      onProgress?.({ label: "chunk", index: i + 1, total: chunks.length });
      if (c.cached) {
        log(`${label} (${range(c)}): unchanged, reusing`);
        continue;
      }
      log(`${label} (${range(c)}): rendering`);
      await writeFile(index, renderHtml(windowPlan(prepared.plan, { from: c.start, to: c.end }), { gsapSrc: "gsap.min.js" }));
      const partial = c.file.replace(/\.mp4$/, ".partial.mp4");
      try {
        await hyperframes(partial);
      } catch (err) {
        await rm(partial, { force: true });
        throw new Error(`${label} (output ${range(c)}) failed: ${(err as Error).message}`);
      }
      await rename(partial, c.file);
    }
  } finally {
    await writeFile(index, renderHtml(prepared.plan, { gsapSrc: "gsap.min.js" }));
  }
  await joinChunks(
    chunks.map((c) => c.file),
    output,
    { workDir: dir, log },
  );
  // Chunks this render did not use are stale edits of the same video.
  const used = new Set(chunks.map((c) => basename(c.file)));
  for (const f of await readdir(dir)) if (f.endsWith(".mp4") && !used.has(f)) await rm(join(dir, f), { force: true });
}

export interface FormatRenderResult extends RenderResult {
  format: string;
}

/**
 * Render the storyboard once per format, one after another (each render is
 * already parallel inside). Every format has its own build dir and output
 * (`<name>.<format>.build` / `.mp4`); the voice cache lives next to the
 * storyboard, so each narration line is synthesized once.
 */
export async function renderFormats(
  storyboardPath: string,
  formats: OutputFormat[],
  opts: Omit<RenderOptions, "buildDir" | "size"> = {},
): Promise<FormatRenderResult[]> {
  const results: FormatRenderResult[] = [];
  for (const f of formats) {
    // Name order: <name>.<style>.<format>.part-A-B
    const { buildDir, output } = formatPaths(storyboardPath, { ...f, label: `${opts.style ? `${opts.style.name}.` : ""}${f.label}` }, opts.window, opts.output);
    opts.log?.(`format ${f.label} (${f.width}x${f.height})`);
    const r = await renderStoryboard(storyboardPath, { ...opts, output, buildDir, size: { width: f.width, height: f.height } });
    results.push({ ...r, format: f.label });
  }
  return results;
}

/** Start (or reuse) the HyperFrames Studio preview for a prepared build. */
export async function startPreview(buildDir: string): Promise<string> {
  const { stdout, stderr } = await run(process.execPath, [hyperframesBin(), "preview", "--background", buildDir], {
    env: hyperframesEnv(),
  });
  return (stdout + stderr).trim();
}
