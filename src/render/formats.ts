import { basename, dirname, extname, join, resolve } from "node:path";
import { partSuffix, type Window } from "./window.js";

// Multi-format export: the same storyboard rendered once per output size.

export interface OutputFormat {
  /** File-name safe: "16x9", "9x16", "1x1", or the custom "1280x720". */
  label: string;
  width: number;
  height: number;
}

const PRESETS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

const accepted = "16:9, 9:16, 1:1 or WxH (e.g. 1280x720)";

/** "16:9,9:16,1:1" or custom "WxH" sizes, comma separated. Duplicates are dropped. */
export function parseFormats(input: string): OutputFormat[] {
  const out: OutputFormat[] = [];
  for (const raw of input.split(",")) {
    const item = raw.trim().toLowerCase();
    const preset = PRESETS[item];
    let f: OutputFormat | undefined;
    if (preset) f = { label: item.replace(":", "x"), ...preset };
    else {
      const m = /^(\d+)x(\d+)$/.exec(item);
      if (m) f = { label: item, width: Number(m[1]), height: Number(m[2]) };
    }
    if (!f || f.width <= 0 || f.height <= 0) throw new Error(`Unknown format "${raw.trim()}". Use ${accepted}.`);
    if (f.width % 2 || f.height % 2) throw new Error(`Format ${f.label}: width and height must be even for H.264.`);
    if (!out.some((o) => o.label === f.label)) out.push(f);
  }
  return out;
}

/**
 * Build dir and output file for one format: `<name>.<label>[.part-A-B].build`
 * and `.mp4` next to the storyboard. `outputBase` (the CLI's --output) replaces
 * the storyboard name and directory; a trailing .mp4 is dropped.
 */
export function formatPaths(
  storyboardPath: string,
  format: OutputFormat,
  window?: Window,
  outputBase?: string,
): { buildDir: string; output: string } {
  const sbBase = join(dirname(resolve(storyboardPath)), basename(storyboardPath, extname(storyboardPath)));
  const suffix = `.${format.label}${window ? partSuffix(window) : ""}`;
  const outBase = outputBase ? resolve(outputBase).replace(/\.mp4$/i, "") : sbBase;
  return { buildDir: `${sbBase}${suffix}.build`, output: `${outBase}${suffix}.mp4` };
}
