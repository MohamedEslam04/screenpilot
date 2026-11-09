import { renderStoryboard } from "../render/index.js";
import { findPausedState, PAUSED_STATE_FILE } from "../render/pause.js";
import { loadStyle } from "../storyboard/load.js";
import { type MemGuardOptions } from "../util/mem.js";
import { renderSequence, type SequenceResult } from "./index.js";

export interface ResumeOverrides extends MemGuardOptions {
  /** The build folder of the paused render, when it was not the default one. */
  buildDir?: string;
  /** Change the worker count for the rest of the render. */
  workers?: number;
  log?: (msg: string) => void;
}

/** What a resumed single render returns (as the render command prints it). */
export interface ResumedRender {
  output: string;
  files: string[];
  timeline: string;
  duration: number;
  autoHolds: { at: number; dur: number }[];
  warnings: string[];
  peakRssMB?: number;
}

/**
 * Carry on a paused render or sequence of `path` (a storyboard or sequence file):
 * render it again with the options it was paused with (saved in `.paused.json`),
 * so every finished part and chunk is a cache hit. `overrides` may change the
 * workers and the memory guard. It can be paused again.
 */
export async function resumePaused(path: string, overrides: ResumeOverrides = {}): Promise<SequenceResult | ResumedRender> {
  const state = await findPausedState(path, overrides.buildDir);
  if (!state) {
    throw new Error(`Nothing paused for ${path}: no ${PAUSED_STATE_FILE} in its build folder. Render it again instead; finished parts and chunks are reused.`);
  }
  const { buildDir: _b, log, ...guard } = overrides;
  const o = state.options;
  const style = o.style ? await loadStyle(o.style) : undefined;
  const pick = <T>(v: T | undefined, saved: T | undefined) => (v === undefined ? saved : v);
  const common = {
    output: o.output,
    buildDir: o.buildDir ?? state.buildDir,
    quality: o.quality,
    style,
    workers: pick(overrides.workers, o.workers),
    pngFrames: o.pngFrames,
    timings: o.timings,
    log,
    ...guard,
    minFreeMemMB: pick(guard.minFreeMemMB, o.minFreeMemMB),
    memTimeoutS: pick(guard.memTimeoutS, o.memTimeoutS),
  };
  log?.(`resuming ${state.path} (paused ${state.pausedAt})`);
  if (state.kind === "sequence") return renderSequence(state.path, common);
  const r = await renderStoryboard(state.path, {
    ...common,
    window: o.window,
    size: o.size,
    chunks: o.chunks,
    chunkSeconds: o.chunkSeconds,
    subtitles: o.subtitles,
    also: o.also,
    posterAt: o.posterAt,
  });
  return { output: r.output, files: r.files, timeline: r.timelineFile, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings, peakRssMB: r.peakRssMB };
}
