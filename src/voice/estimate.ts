import { existsSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../brand.js";
import { type LoadedStyle, loadStoryboard } from "../storyboard/load.js";
import type { Storyboard } from "../storyboard/schema.js";
import { clipFile, estimateLineSeconds, getProvider } from "./index.js";
import { countChars, creditsFor, usdPerCredit } from "./spend.js";

// What a render would send to the voice service, worked out BEFORE any request. Nothing is
// written (no cache entry, no ledger row): a dry run only reads the storyboard and looks
// at which clips are already in the cache.

export interface NarrationEstimate {
  dryRun: true;
  provider: string;
  /** Lines that would be sent to the service (not cached, no ready-made audio). */
  lines: number;
  /** Lines whose clip is already in the cache: free. */
  cachedLines: number;
  chars: number;
  /** Spoken length of the new lines, estimated from their text. */
  estimatedAudioSeconds: number;
  credits: number;
  /** 0 for a free voice (edge, local, command). */
  estimatedUsd: number;
  usdPerCredit: number;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Estimate the narration of one storyboard. `seen` holds the clips already counted
 * (by file), so a line used twice, or by two parts that share a cache, counts once.
 */
export function estimateNarration(sb: Pick<Storyboard, "narration" | "voice">, baseDir: string, seen: Set<string> = new Set()): NarrationEstimate {
  const provider = getProvider(sb.voice.provider);
  const dir = join(baseDir, CACHE_DIR, "voice");
  let lines = 0;
  let cachedLines = 0;
  let chars = 0;
  let audio = 0;
  let credits = 0;
  for (const n of sb.narration) {
    if (n.audio) continue;
    const line = { text: n.text, voice: n.voice ?? sb.voice.name, rate: sb.voice.rate };
    const file = clipFile(provider, line, dir);
    if (seen.has(file)) continue;
    seen.add(file);
    if (existsSync(file)) {
      cachedLines++;
      continue;
    }
    const seconds = estimateLineSeconds(line.text);
    lines++;
    chars += countChars(line.text);
    audio += seconds;
    credits += creditsFor(provider.id, countChars(line.text), seconds);
  }
  const price = usdPerCredit(provider.id);
  return { dryRun: true, provider: provider.id, lines, cachedLines, chars, estimatedAudioSeconds: round(audio, 1), credits, estimatedUsd: round(credits * price, 4), usdPerCredit: price };
}

/** `render --dry-run`: the estimate for a storyboard file. */
export async function estimateStoryboard(path: string, opts: { style?: LoadedStyle } = {}): Promise<NarrationEstimate> {
  const { sb, baseDir } = await loadStoryboard(path, { style: opts.style });
  return estimateNarration(sb, baseDir);
}

/** One line for the log: what the estimate says. */
export function describeEstimate(e: Pick<NarrationEstimate, "lines" | "cachedLines" | "chars" | "estimatedUsd">, label = ""): string {
  const usd = e.estimatedUsd > 0 && e.estimatedUsd < 0.01 ? e.estimatedUsd.toFixed(4) : e.estimatedUsd.toFixed(2);
  return `dry run${label}: ${e.lines} line(s) to send, ${e.chars} characters, about $${usd} (${e.cachedLines} already cached); nothing was sent or written`;
}
