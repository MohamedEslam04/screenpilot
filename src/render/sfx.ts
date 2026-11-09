import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isBuiltinSfx, SFX_BUILTINS, type Storyboard } from "../storyboard/schema.js";
import type { Timeline } from "../storyboard/timeline.js";
import { run } from "../util/exec.js";
import { ffmpegFilterScriptFlag } from "../util/media.js";
import { outroFadeIn } from "./plan.js";
import { typingPresses } from "./typing.js";

export { typingPresses };

// Sound effects. Every hit (explicit sfx[] and the automatic click/key/card sounds)
// is mixed into ONE wav, so the composition carries a single <audio> element however
// many sounds there are, and a partial render trims it like any other audio item.

export const BUILTIN_SFX = SFX_BUILTINS;
export type BuiltinSfx = (typeof BUILTIN_SFX)[number];

const SAMPLE_RATE = 48000;
/** No two automatic sounds of one kind closer than this in the output (s); a sped-up stretch would otherwise machine-gun. */
const CLICK_GAP = 0.05;
const TYPING_GAP = 0.06;

// Built-in sounds are synthesized by ffmpeg when a render needs them, so nothing is
// downloaded, shipped or licensed. aevalsrc's random(0) is seeded the same way every
// run, so a render is repeatable. (No commas inside an expression: lavfi splits on them.)
const DEFS: Record<BuiltinSfx, { expr: string; dur: number; post?: string }> = {
  click: { expr: "(0.55*sin(2*PI*2200*t)+0.45*(2*random(0)-1))*exp(-t*140)", dur: 0.05 },
  key: { expr: "0.7*(0.6*sin(2*PI*1100*t)+0.4*(2*random(0)-1))*exp(-t*110)", dur: 0.06 },
  pop: { expr: "0.8*sin(2*PI*(420*t+3500*t*t))*exp(-t*28)", dur: 0.14 },
  ding: { expr: "0.5*(sin(2*PI*1319*t)+0.5*sin(2*PI*1976*t)+0.25*sin(2*PI*2637*t))*exp(-t*5.5)*(1-exp(-t*800))", dur: 0.9 },
  whoosh: { expr: "0.9*(2*random(0)-1)*sin(PI*t/0.6)*sin(PI*t/0.6)", dur: 0.6, post: ",highpass=f=250,lowpass=f=3500" },
};

/** ffmpeg input arguments that generate a built-in sound. */
export function builtinSfxInput(name: BuiltinSfx): string[] {
  const d = DEFS[name];
  return ["-f", "lavfi", "-i", `aevalsrc=${d.expr}:d=${d.dur}:s=${SAMPLE_RATE}${d.post ?? ""}`];
}

export interface SfxInput {
  /** Same sound = same id, so a source is read once however many times it plays. */
  id: string;
  /** ffmpeg input arguments. */
  input: string[];
  /** The file, when the sound is one (used for the cache key). */
  file?: string;
}

/** Resolve `builtin:<name>` or a file relative to the storyboard. Undefined for an unknown built-in. */
export function sfxInput(src: string, baseDir: string): SfxInput | undefined {
  if (src.startsWith("builtin:")) {
    const name = src.slice("builtin:".length);
    return isBuiltinSfx(name) ? { id: src, input: builtinSfxInput(name) } : undefined;
  }
  const file = isAbsolute(src) ? src : resolve(baseDir, src);
  return { id: file, file, input: ["-i", file] };
}

export interface SfxHit {
  /** `builtin:<name>` or a file relative to the storyboard. */
  src: string;
  /** Output seconds. */
  at: number;
  volume: number;
}

export interface PlanSfxInput {
  sb: Storyboard;
  timeline: Timeline;
  clicks: { t: number }[];
  /** Output length (s). */
  duration: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function choice(value: boolean | string | undefined, builtin: BuiltinSfx): string | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? `builtin:${builtin}` : isBuiltinSfx(value) ? `builtin:${value}` : value;
}

/** Everything that plays, in output seconds, sorted by time. */
export function planSfx({ sb, timeline: tl, clicks, duration }: PlanSfxInput): { hits: SfxHit[]; warnings: string[] } {
  const hits: SfxHit[] = [];
  const warnings: string[] = [];
  const add = (src: string, at: number, volume: number) => {
    const t = round(at);
    if (t >= 0 && t < duration) hits.push({ src, at: t, volume });
  };

  sb.sfx.forEach((s, i) => {
    const at = tl.toOutput(s.at);
    if (at === null) warnings.push(`sfx[${i}] at ${s.at}s falls in a cut region and was dropped`);
    else add(s.src, at, s.volume);
  });

  const sounds = sb.sounds;
  if (sounds) {
    /** `times` are source seconds; they are mapped first, so the gap applies to what the viewer hears. */
    const auto = (src: string | undefined, times: number[], gap: number): number => {
      if (!src) return 0;
      const mapped = times.flatMap((t) => {
        const at = tl.toOutput(t);
        return at === null ? [] : [at];
      });
      let last = -Infinity;
      for (const at of mapped.sort((a, b) => a - b)) {
        if (at - last < gap - 1e-9) continue;
        last = at;
        add(src, at, sounds.volume);
      }
      return mapped.length;
    };
    auto(choice(sounds.clicks, "click"), clicks.map((c) => c.t), CLICK_GAP);
    const typing = choice(sounds.typing, "key");
    sb.typing.forEach((span, i) => {
      if (auto(typing, typingPresses(span, i), TYPING_GAP) === 0 && typing) warnings.push(`typing[${i}] at ${span.at}s falls in a cut region and was dropped`);
    });

    const cards = choice(sounds.cards, "whoosh");
    if (cards) {
      if (sb.intro) add(cards, 0, sounds.volume);
      for (const span of tl.cardSpans()) add(cards, span.start, sounds.volume);
      if (sb.outro) add(cards, tl.videoEnd - outroFadeIn(tl.videoDuration), sounds.volume);
    }
  }

  return { hits, warnings };
}

export interface SfxMixHit extends SfxInput {
  at: number;
  volume: number;
}

/** Filter graph that places every hit at its time and sums them into one stereo track of exactly `duration` seconds. */
export function buildSfxMix(hits: SfxMixHit[], duration: number): { inputs: string[]; filter: string } {
  const order: string[] = [];
  const byId = new Map<string, { input: string[]; hits: SfxMixHit[] }>();
  for (const h of hits) {
    let g = byId.get(h.id);
    if (!g) {
      g = { input: h.input, hits: [] };
      byId.set(h.id, g);
      order.push(h.id);
    }
    g.hits.push(h);
  }

  const inputs: string[] = [];
  const lines: string[] = [];
  const labels: string[] = [];
  order.forEach((id, k) => {
    const g = byId.get(id)!;
    inputs.push(...g.input);
    const n = g.hits.length;
    const outs = g.hits.map((_, j) => `[s${k}_${j}]`).join("");
    lines.push(`[${k}:a]aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,${n > 1 ? `asplit=${n}${outs}` : `anull${outs}`}`);
    g.hits.forEach((h, j) => {
      const ms = Math.max(0, Math.round(h.at * 1000));
      const label = `h${labels.length}`;
      labels.push(`[${label}]`);
      lines.push(`[s${k}_${j}]volume=${+h.volume.toFixed(3)},adelay=${ms}|${ms}[${label}]`);
    });
  });

  // A silent track as long as the video is mixed in too, so the result is exactly `duration`
  // long (apad after amix stopped at the last sound in practice).
  const total = +duration.toFixed(3);
  const base = order.length;
  inputs.push("-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo:d=${total}`);
  lines.push(`[${base}:a]${labels.join("")}amix=inputs=${labels.length + 1}:normalize=0:duration=longest,atrim=end=${total},alimiter=limit=0.95[out]`);
  return { inputs, filter: lines.join(";\n") };
}

export interface MixResult {
  /** The mixed track, or undefined when nothing plays. */
  file?: string;
  warnings: string[];
}

/** Mix the hits into `<buildDir>/sfx.wav` (cached on the filter and the sound files). */
export async function mixSfx(hits: SfxHit[], opts: { baseDir: string; buildDir: string; duration: number; log?: (m: string) => void }): Promise<MixResult> {
  const warnings: string[] = [];
  const mix: SfxMixHit[] = [];
  const missing = new Set<string>();
  for (const h of hits) {
    const input = sfxInput(h.src, opts.baseDir);
    if (!input) {
      if (!missing.has(h.src)) warnings.push(`unknown built-in sound "${h.src}" (use ${BUILTIN_SFX.map((n) => `builtin:${n}`).join(", ")}) and was skipped`);
      missing.add(h.src);
    } else if (input.file && !existsSync(input.file)) {
      if (!missing.has(h.src)) warnings.push(`sound file not found: ${input.file}`);
      missing.add(h.src);
    } else mix.push({ ...input, at: h.at, volume: h.volume });
  }
  if (mix.length === 0) return { warnings };

  const { inputs, filter } = buildSfxMix(mix, opts.duration);
  const files = await Promise.all(
    [...new Set(mix.flatMap((m) => (m.file ? [m.file] : [])))].map(async (f) => {
      const st = await stat(f);
      return `${f}:${st.size}:${st.mtimeMs}`;
    }),
  );
  const key = createHash("sha1").update(`${filter}|${inputs.join(" ")}|${files.join("|")}`).digest("hex");
  const out = join(opts.buildDir, "sfx.wav");
  const keyFile = join(opts.buildDir, "sfx.key");
  if (existsSync(out) && existsSync(keyFile) && (await readFile(keyFile, "utf8")) === key) {
    opts.log?.("sfx: unchanged, reusing sfx.wav");
    return { file: "sfx.wav", warnings };
  }
  opts.log?.(`sfx: mixing ${mix.length} sound(s)`);
  const script = join(opts.buildDir, "sfx.filter");
  await writeFile(script, filter);
  await rm(keyFile, { force: true }); // an aborted run leaves a half-written file
  await run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, await ffmpegFilterScriptFlag(), script, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", "2", out]);
  await writeFile(keyFile, key);
  return { file: "sfx.wav", warnings };
}
