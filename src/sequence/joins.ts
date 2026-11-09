import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { recordEvent } from "../history/index.js";
import { startJob } from "../history/jobs.js";
import { clearPause, pauseRequested, RenderPaused, resumeCommand, writePausedState } from "../render/pause.js";
import { checkTranslations } from "../render/subtitle-langs.js";
import { StoryboardError } from "../storyboard/load.js";
import { variantName } from "../storyboard/variant.js";
import { memGuardSettings, startRssSampler } from "../util/mem.js";
import { withProcessScope } from "../util/proc.js";
import {
  type PreparedSequence,
  type PreparedSequencePart,
  prepareSequence,
  renderPrepared,
  type SequenceRenderOptions,
  type SequenceResult,
  sequenceResumeOptions,
  writeJoinedSubtitles,
} from "./index.js";
import { type Transition, TRANSITIONS, TransitionSchema } from "./schema.js";

// Several joined videos from shared groups in one call (`sequence --joins setup=g1.json+g2.json,full=setup+g3.json`).
// A group is a sequence file. Each joined video is an in-memory sequence whose parts are those groups (nested
// sequence parts, the same mechanism as `{sequence: "group.json"}`), so the join, its xfade/acrossfade graph, the
// clamping of the transition and timeline.json are exactly a sequence's. Every group has ONE folder in the joins
// build folder for all the joined videos, so its part.key makes it a cache hit after the first video that uses it.

export interface JoinsSpec {
  /** Joined video name -> what it is made of, in order: sequence files (groups) or names of other joined videos (their groups are used). */
  joins: Record<string, string[]>;
  /** How each group enters from the one before it (default: cut). */
  transition?: Transition;
  /** Folder that relative sequence files are read from (default: the working folder). */
  baseDir?: string;
}

export interface JoinsRenderOptions extends Omit<SequenceRenderOptions, "output"> {
  /** Folder of the joined videos `<name>[.<variant>][.<style>].mp4` (default: the folder holding all the groups). */
  outputDir?: string;
}

export interface JoinsResult {
  /** One per joined video, in the order given: what sequence_render returns for it, with its name. */
  joins: (SequenceResult & { name: string })[];
  /** Every group once: rendered by this call (false: reused from an earlier one). */
  groups: { sequence: string; output: string; rendered: boolean }[];
  peakRssMB?: number;
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** `setup=g1.json+g2.json,operations=g3.json,full=setup+operations` -> {setup: [...], ...}, in order. */
export function parseJoins(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const pairs = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (!pairs.length) throw new Error("--joins needs at least one name=a+b (e.g. setup=g1.json+g2.json,full=setup+g3.json)");
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new Error(`--joins: "${pair}" is not name=a+b`);
    const name = pair.slice(0, eq).trim();
    if (!NAME.test(name)) throw new Error(`--joins: name "${name}" may only have letters, digits, - and _ (it names the video file)`);
    if (out[name]) throw new Error(`--joins: "${name}" twice`);
    const refs = pair.slice(eq + 1).split("+").map((r) => r.trim()).filter(Boolean);
    if (!refs.length) throw new Error(`--joins: "${name}" has no sequence`);
    out[name] = refs;
  }
  return out;
}

/** `fade-black:0.6` (or `fade-black`, 0.5 s) -> a transition; `cut` joins without one. */
export function parseJoinTransition(value: string): Transition {
  const [type, dur] = value.split(":").map((x) => x.trim());
  const r = TransitionSchema.safeParse({ type, ...(dur ? { dur: Number(dur) } : {}) });
  if (!r.success) throw new Error(`--join-transition "${value}": use type[:seconds] with a type of ${TRANSITIONS.join(", ")} (e.g. fade-black:0.6)`);
  return r.data;
}

/** Every joined video as its groups (absolute sequence files, in order): names are replaced by their groups; a loop fails with the chain. */
export function expandJoins(joins: Record<string, string[]>, baseDir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const expand = (name: string, chain: string[]): string[] => {
    if (chain.includes(name)) throw new Error(`joins: ${[...chain, name].join(" → ")} includes itself`);
    return joins[name]!.flatMap((ref) => (Object.hasOwn(joins, ref) ? expand(ref, [...chain, name]) : [isAbsolute(ref) ? ref : resolve(baseDir, ref)]));
  };
  for (const name of Object.keys(joins)) {
    if (!NAME.test(name)) throw new Error(`joins: name "${name}" may only have letters, digits, - and _ (it names the video file)`);
    if (!joins[name]!.length) throw new Error(`joins: "${name}" has no sequence`);
    out[name] = expand(name, []);
  }
  if (!Object.keys(out).length) throw new Error("joins: nothing to join");
  return out;
}

/** What pause, resume and the live-job list call the joins written to `outputDir` (no such file; `<it>.build` is the build folder). */
export const joinsPath = (outputDir: string) => join(resolve(outputDir), "joins");

/** The deepest folder holding every file. */
function commonDir(files: string[]): string {
  let dir = dirname(files[0]!);
  while (files.some((f) => relative(dir, f).startsWith("..")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/**
 * Render several joined videos that share groups: every group (a sequence) is rendered once, then each
 * video is joined from its groups with `transition` between them and gets its own timeline.json (and
 * caption files, when asked). Pause, abort, the memory guard, style, variant and fit work as in renderSequence;
 * a pause stops between parts and `resume <outputDir>/joins` carries on.
 */
export function renderJoins(spec: JoinsSpec, opts: JoinsRenderOptions = {}): Promise<JoinsResult> {
  return withProcessScope(() => renderJoinsTracked(spec, opts), { signal: opts.signal });
}

async function renderJoinsTracked(spec: JoinsSpec, opts: JoinsRenderOptions): Promise<JoinsResult> {
  const since = Date.now();
  memGuardSettings(opts); // bad values fail before any work
  await checkTranslations(opts.subtitleLanguages);
  const baseDir = resolve(spec.baseDir ?? ".");
  const expanded = expandJoins(spec.joins, baseDir);
  const files = [...new Set(Object.values(expanded).flat())];
  const outputDir = resolve(opts.outputDir ?? commonDir(files));
  const path = joinsPath(outputDir);
  const buildDir = resolve(opts.buildDir ?? join(outputDir, `joins${opts.style ? `.${opts.style.name}` : ""}.build`));
  const label = opts.variant ? variantName(opts.variant) : undefined;

  // Each group is prepared once and has one folder (and part.key) for every joined video that uses it.
  const groups = new Map<string, PreparedSequencePart>();
  const issues: string[] = [];
  for (const file of files) {
    try {
      const sequence = await prepareSequence(file, { style: opts.style, variant: opts.variant, variantDir: opts.variantDir, fit: opts.fit });
      const dir = join(buildDir, `group-${basename(file, extname(file))}-${sha1(file).slice(0, 8)}${sequence.usesVariant && label ? `.${label}` : ""}`);
      await mkdir(dir, { recursive: true });
      groups.set(file, { kind: "sequence", index: 0, dir, output: join(dir, "part.mp4"), key: sequence.key, sequence, ...(sequence.usesVariant ? { usesVariant: true } : {}) });
    } catch (err) {
      if (!(err instanceof StoryboardError)) throw err;
      issues.push(...(err.issues.length ? err.issues : [err.message]).map((x) => `${file}: ${x}`));
    }
  }
  if (issues.length) throw new StoryboardError("Invalid joins", issues);

  const quality = opts.quality ?? "looks";
  const job = startJob({ kind: "sequence", path, quality });
  const sampler = startRssSampler();
  const started = performance.now();
  const wall = () => Math.round(((performance.now() - started) / 1000) * 1000) / 1000;
  const shouldPause = () => pauseRequested(buildDir, since);
  const joins: JoinsResult["joins"] = [];
  const rendered = new Map<string, boolean>();
  let current = "";
  try {
    for (const [name, refs] of Object.entries(expanded)) {
      current = name;
      const parts = refs.map((file, index) => ({ ...groups.get(file)!, index, transition: index ? spec.transition : undefined }));
      const prepared: PreparedSequence = {
        path,
        buildDir: join(buildDir, `join-${name}`),
        output: parts[0]!.sequence.output,
        parts,
        style: opts.style?.name,
        ...(label ? { variant: label } : {}),
        key: sha1(JSON.stringify(parts.map((p) => [p.key, p.transition ?? null]))),
        usesVariant: parts.some((p) => p.usesVariant),
      };
      await mkdir(prepared.buildDir, { recursive: true });
      const output = join(outputDir, `${name}${label ? `.${label}` : ""}${opts.style ? `.${opts.style.name}` : ""}.mp4`);
      opts.log?.(`join ${name}: ${refs.length} group(s)`);
      const r = await renderPrepared(prepared, { ...opts, output, onProgress: (step) => job.update(step) }, shouldPause);
      await writeJoinedSubtitles(r, opts);
      r.parts.forEach((p, i) => !rendered.has(refs[i]!) && rendered.set(refs[i]!, !p.cached));
      joins.push({ name, ...r });
      await recordEvent({ kind: "sequence", status: "ok", path, output: r.output, durationSec: r.duration, quality, wallSeconds: wall() });
    }
    const peakRssMB = await sampler.stop();
    await clearPause(buildDir);
    return { joins, groups: files.map((f) => ({ sequence: f, output: groups.get(f)!.output, rendered: rendered.get(f) ?? false })), ...(peakRssMB !== undefined ? { peakRssMB } : {}) };
  } catch (err) {
    await sampler.stop();
    if (err instanceof RenderPaused) {
      const stateFile = await writePausedState({
        version: 1,
        kind: "joins",
        path,
        buildDir,
        pausedAt: new Date().toISOString(),
        options: { ...sequenceResumeOptions(opts), buildDir, joins: spec.joins, joinTransition: spec.transition, baseDir, outputDir },
      });
      const resume = resumeCommand(path);
      opts.log?.(`paused in ${current}: ${err.info.partsDone}/${err.info.partsTotal} groups done; carry on with: ${resume}`);
      throw new RenderPaused({ ...err.info, kind: "joins", path, join: current, buildDir, stateFile, resume });
    }
    await recordEvent({ kind: "sequence", status: "failed", path, quality, wallSeconds: wall(), error: (err as Error).message.slice(0, 500) });
    throw err;
  } finally {
    job.end();
  }
}
