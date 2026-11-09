import { resolve } from "node:path";
import type { LoadedStyle } from "../storyboard/load.js";
import { estimateNarration, type NarrationEstimate } from "../voice/estimate.js";
import { clipPart, loadParts, loadSequence } from "./index.js";

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
 * not even the build folder; finished video parts cost nothing.
 */
export async function estimateSequence(path: string, opts: { style?: LoadedStyle } = {}): Promise<SequenceEstimate> {
  const parts: SequenceEstimate["parts"] = [];
  await collect(resolve(path), [], opts.style, new Set(), parts);
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

async function collect(path: string, ancestors: string[], style: LoadedStyle | undefined, seen: Set<string>, out: SequenceEstimate["parts"]): Promise<void> {
  const loaded = await loadSequence(path);
  const chain = [...ancestors, loaded.path];
  const loadedParts = await loadParts(loaded, chain, style);
  for (const [index, lp] of loadedParts.entries()) {
    const part = loaded.seq.parts[index]!;
    if (lp.kind === "sequence") await collect(lp.file, chain, style, seen, out);
    else if (lp.kind === "storyboard") {
      const sb = await clipPart(loaded, index, lp.sb, lp.baseDir);
      out.push({ part: `${part.storyboard} (part ${index + 1})`, ...estimateNarration(sb, lp.baseDir, seen) });
    }
  }
}
