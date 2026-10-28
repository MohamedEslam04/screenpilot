import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lintStyle } from "./lint.js";
import { INHERITED_KEYS, type Storyboard, StoryboardSchema } from "./schema.js";
import { normalizeSegments, Timeline } from "./timeline.js";

export interface LoadedStoryboard {
  sb: Storyboard;
  path: string;
  baseDir: string;
}

export class StoryboardError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(`${message}\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

export function parseStoryboard(data: unknown): { ok: true; sb: Storyboard } | { ok: false; issues: string[] } {
  const r = StoryboardSchema.safeParse(data);
  if (r.success) return { ok: true, sb: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** Problems the schema cannot express (ordering, overlaps). Not fatal. */
export function lintStoryboard(sb: Storyboard, sourceDuration?: number): string[] {
  const warnings: string[] = [];
  const segs = sb.segments;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i]!.in < segs[i - 1]!.out) warnings.push(`segments[${i}] overlaps segments[${i - 1}]`);
  }
  if (sourceDuration !== undefined) {
    const check = (label: string, t: number) => {
      if (t > sourceDuration + 0.01) warnings.push(`${label} at ${t}s is past the end of the source (${sourceDuration.toFixed(2)}s)`);
    };
    sb.zooms.forEach((z, i) => check(`zooms[${i}]`, z.at));
    sb.captions.forEach((c, i) => check(`captions[${i}]`, c.at));
    sb.narration.forEach((c, i) => check(`narration[${i}]`, c.at));
    sb.highlights.forEach((c, i) => check(`highlights[${i}]`, c.at));
    sb.views.forEach((c, i) => check(`views[${i}]`, c.at));
    const kept = normalizeSegments(sb.segments, sourceDuration);
    sb.cards.forEach((c, i) => {
      if (Timeline.segmentIndexOf(kept, c.at) < 0) warnings.push(`cards[${i}] at ${c.at}s is in a cut region and will be dropped`);
    });
  }
  const names = new Set(sb.screens.map((s) => s.name));
  sb.views.forEach((v, i) => {
    if (v.screen && v.screen !== "all" && !names.has(v.screen)) warnings.push(`views[${i}] names unknown screen "${v.screen}"`);
  });
  sb.captions.forEach((c, i) => {
    if (c.style === "callout" && (c.x === undefined || c.y === undefined)) {
      warnings.push(`captions[${i}] is a callout without x/y; it will point at the center`);
    }
  });
  warnings.push(...lintStyle(sb));
  return warnings;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; anything else (arrays too) is replaced by the child. */
function deepMerge(base: unknown, child: unknown): unknown {
  if (!isObject(base) || !isObject(child)) return child === undefined ? base : child;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(child)) out[k] = deepMerge(base[k], v);
  return out;
}

async function readJson(abs: string, extendedBy?: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(abs, "utf8"));
  } catch (err) {
    const by = extendedBy ? ` (extended by ${extendedBy})` : "";
    throw new StoryboardError(`Cannot read ${abs}${by}`, [(err as Error).message]);
  }
}

/**
 * Apply `extends`: the base's inherited keys (resolved recursively) under the
 * child's. Paths in what is inherited are rebased to stay valid next to `abs`.
 */
async function resolveExtends(raw: unknown, abs: string, chain: string[] = []): Promise<unknown> {
  if (!isObject(raw) || typeof raw.extends !== "string") return raw;
  const basePath = resolve(dirname(abs), raw.extends);
  const seen = [...chain, abs];
  if (seen.includes(basePath)) throw new StoryboardError("Invalid storyboard", [`extends cycle: ${[...seen, basePath].join(" -> ")}`]);
  const base = await resolveExtends(await readJson(basePath, abs), basePath, seen);
  const inherited: Json = {};
  if (isObject(base)) {
    for (const k of INHERITED_KEYS) if (base[k] !== undefined) inherited[k] = base[k];
    if (isObject(inherited.music) && typeof inherited.music.src === "string" && !isAbsolute(inherited.music.src)) {
      const src = relative(dirname(abs), resolve(dirname(basePath), inherited.music.src));
      inherited.music = { ...inherited.music, src: src.split(sep).join("/") };
    }
  }
  const { extends: _extends, ...own } = raw;
  return deepMerge(inherited, own);
}

export async function loadStoryboard(path: string): Promise<LoadedStoryboard> {
  const abs = resolve(path);
  const raw = await resolveExtends(await readJson(abs), abs);
  const r = parseStoryboard(raw);
  if (!r.ok) throw new StoryboardError(`Invalid storyboard ${abs}`, r.issues);
  return { sb: r.sb, path: abs, baseDir: dirname(abs) };
}
