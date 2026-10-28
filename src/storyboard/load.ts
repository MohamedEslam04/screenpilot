import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { lintStyle } from "./lint.js";
import { type Storyboard, StoryboardSchema } from "./schema.js";
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

export async function loadStoryboard(path: string): Promise<LoadedStoryboard> {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch (err) {
    throw new StoryboardError(`Cannot read ${abs}`, [(err as Error).message]);
  }
  const r = parseStoryboard(raw);
  if (!r.ok) throw new StoryboardError(`Invalid storyboard ${abs}`, r.issues);
  return { sb: r.sb, path: abs, baseDir: dirname(abs) };
}
