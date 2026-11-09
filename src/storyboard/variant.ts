import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { StoryboardError } from "./errors.js";
import { deepMerge, isObject, type Json } from "./json.js";
import { type Variant, VariantSchema } from "./schema.js";

export interface LoadedVariant {
  path: string;
  /** File name without extension, reduced to [a-z0-9-]; used in output, build folder and cache key names. */
  name: string;
  /** First 12 hex digits of the sha1 of the file: part of every cache key, so an edited variant renders again. */
  hash: string;
  /** The file as written (no schema defaults). */
  data: Variant;
}

export const variantName = (file: string) => basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "variant";

/** A value with a path separator or a .json ending is a file; anything else is a name. */
export const isVariantFile = (arg: string) => /[\\/]/.test(arg) || arg.toLowerCase().endsWith(".json");

/** `variants/<name>.json` in this folder (the folder of a storyboard). */
export const variantFileIn = (dir: string, name: string) => join(dir, "variants", `${name}.json`);

/** Read and check a variant file. `arg` is a file path or a name looked up as variants/<name>.json next to the storyboard. */
export async function loadVariant(arg: string, storyboardPath: string): Promise<LoadedVariant> {
  return readVariant(isVariantFile(arg) ? resolve(arg) : variantFileIn(dirname(resolve(storyboardPath)), arg));
}

export async function readVariant(abs: string): Promise<LoadedVariant> {
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    throw new StoryboardError(`Cannot read variant ${abs}`, [(err as Error).message]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new StoryboardError(`Cannot read variant ${abs}`, [(err as Error).message]);
  }
  const r = VariantSchema.safeParse(raw);
  if (!r.success) {
    throw new StoryboardError(
      `Invalid variant ${abs}`,
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return { path: abs, name: variantName(abs), hash: createHash("sha1").update(text).digest("hex").slice(0, 12), data: raw as Variant };
}

/** `.<variant>` in default build dir and output names; nothing without a variant. */
export const variantSuffix = (variant?: Pick<LoadedVariant, "name">) => (variant ? `.${variant.name}` : "");

/** What goes into a cache key for this variant (nothing without one). */
export const variantKey = (variant?: Pick<LoadedVariant, "name" | "hash">) => (variant ? `variant:${variant.name}:${variant.hash}` : "");

/**
 * Apply a variant to a storyboard as written (after `extends` and a style, before validation), so every field it
 * does not name is untouched. A variant rewrites; it never changes how many narration lines there are.
 */
export function applyVariant(raw: unknown, variant: LoadedVariant): unknown {
  if (!isObject(raw)) return raw;
  const out: Json = { ...raw };
  const issues: string[] = [];
  const v = variant.data;

  if (v.voice !== undefined) out.voice = deepMerge(raw.voice, v.voice);

  if (v.narration !== undefined) {
    const lines: unknown[] = Array.isArray(raw.narration) ? raw.narration : [];
    const idOf = (line: unknown, i: number) => (isObject(line) && typeof line.id === "string" ? line.id : String(i));
    const texts = new Map<number, string>();
    if (Array.isArray(v.narration)) {
      if (v.narration.length !== lines.length) {
        issues.push(
          `narration: the variant has ${v.narration.length} line(s) but the storyboard has ${lines.length} line(s). Lines are timed to the recording, so a variant can only rewrite them; add or remove lines in the storyboard itself`,
        );
      } else v.narration.forEach((t, i) => texts.set(i, t));
    } else {
      const index = new Map<string, number>();
      lines.forEach((l, i) => {
        const id = idOf(l, i);
        if (!index.has(id)) index.set(id, i);
      });
      const unknown: string[] = [];
      for (const [key, text] of Object.entries(v.narration)) {
        const i = index.get(key);
        if (i === undefined) unknown.push(`"${key}"`);
        else texts.set(i, text);
      }
      if (unknown.length) {
        issues.push(
          `narration: the variant names ${Object.keys(v.narration).length} line(s) but the storyboard has ${lines.length} line(s); no line has the id or position ${unknown.join(", ")}. A variant can only rewrite existing lines`,
        );
      }
    }
    if (!issues.length) out.narration = lines.map((l, i) => (texts.has(i) && isObject(l) ? { ...l, text: texts.get(i) } : l));
  }

  if (v.overlays !== undefined) {
    const overlays: unknown[] = Array.isArray(raw.overlays) ? raw.overlays : [];
    const bad = Object.keys(v.overlays).filter((k) => !/^\d+$/.test(k) || Number(k) >= overlays.length);
    if (bad.length) issues.push(`overlays: the storyboard has ${overlays.length} overlay(s); no overlay at position ${bad.map((b) => `"${b}"`).join(", ")}`);
    else out.overlays = overlays.map((o, i) => (v.overlays![String(i)] && isObject(o) ? { ...o, src: v.overlays![String(i)]!.src } : o));
  }

  if (issues.length) throw new StoryboardError(`Variant ${variant.path} does not fit the storyboard`, issues);
  return out;
}
