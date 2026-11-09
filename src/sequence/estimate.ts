import { resolve } from "node:path";
import type { LoadedStyle } from "../storyboard/load.js";
import { estimateNarration, type NarrationEstimate } from "../voice/estimate.js";
import { clipPart, loadParts, loadSequence, type SequenceVariant, type VariantOptions } from "./index.js";

export interface SequenceEstimate {
  dryRun: true;
  lines: number;
  cachedLines: number;
  chars: number;
  estimatedUsd: number;
  providers: string[];
  /** One entry per storyboard part, in order (a nested sequence is flattened into it). */
  parts: (NarrationEstimate & { part: string })[];
}

/**
 * `sequence --dry-run`: what rendering the sequence would send to the voice services, part by
 * part (only the range of each part), before any request. Unlike a real run it writes nothing,
 * not even the build folder; finished video parts cost nothing. Several paths (the groups of `--joins`) are priced together.
 */
export async function estimateSequence(path: string | string[], opts: { style?: LoadedStyle } & VariantOptions = {}): Promise<SequenceEstimate> {
  const parts: SequenceEstimate["parts"] = [];
  const variant: SequenceVariant | undefined = opts.variant ? { name: opts.variant, dir: opts.variantDir ? resolve(opts.variantDir) : undefined } : undefined;
  // Several sequences (the groups of `--joins`): a line said in two of them is priced once, like the render's voice cache.
  const seen = new Set<string>();
  for (const p of typeof path === "string" ? [path] : path) await collect(resolve(p), [], opts.style, seen, parts, variant);
  const sum = (f: (p: NarrationEstimate) => number) => parts.reduce((a, p) => a + f(p), 0);
  return {
    dryRun: true,
    lines: sum((p) => p.lines),
    cachedLines: sum((p) => p.cachedLines),
    chars: sum((p) => p.chars),
    estimatedUsd: Math.round(sum((p) => p.estimatedUsd) * 10_000) / 10_000,
    providers: [...new Set(parts.map((p) => p.provider))],
    parts,
  };
}

async function collect(path: string, ancestors: string[], style: LoadedStyle | undefined, seen: Set<string>, out: SequenceEstimate["parts"], variant?: SequenceVariant): Promise<void> {
  const loaded = await loadSequence(path);
  const chain = [...ancestors, loaded.path];
  const loadedParts = await loadParts(loaded, chain, style, variant);
  for (const [index, lp] of loadedParts.entries()) {
    const part = loaded.seq.parts[index]!;
    if (lp.kind === "sequence") await collect(lp.file, chain, style, seen, out, variant);
    else if (lp.kind === "storyboard") {
      const sb = await clipPart(loaded, index, lp.sb, lp.baseDir);
      out.push({ part: `${part.storyboard} (part ${index + 1})`, ...estimateNarration(sb, lp.baseDir, seen) });
    }
  }
}
