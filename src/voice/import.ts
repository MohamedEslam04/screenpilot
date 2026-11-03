import { writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { loadStoryboard } from "../storyboard/load.js";
import { attachAudio } from "./attach.js";
import { buildScript } from "./script.js";
import { type SplitOptions, splitAudio } from "./split.js";

export interface ScriptExport {
  file: string;
  language: string;
  lines: number;
  /** The text to paste into the TTS site. */
  text: string;
}

/** Write the narration as a script file (default `<storyboard>.script.md`). */
export async function exportScript(storyboardPath: string, out?: string): Promise<ScriptExport> {
  const { sb, path } = await loadStoryboard(storyboardPath);
  const name = basename(path, extname(path));
  const script = buildScript(sb, `Narration script: ${name}`);
  const file = resolve(out ?? join(dirname(path), `${name}.script.md`));
  await writeFile(file, script.markdown);
  return { file, language: script.language, lines: script.lines.length, text: script.plain };
}

export interface ImportOptions extends SplitOptions {
  /** Storyboard whose narration lines the audio belongs to (also sets each line's `audio`). */
  storyboard?: string;
  /** Number of lines when there is no storyboard. */
  lines?: number;
  /** Folder for the per-line files. */
  out?: string;
}

export interface ImportResult {
  files: string[];
  /** True when the storyboard's narration lines now point at the files. */
  attached: boolean;
  warnings: string[];
}

/** Split one recording of the whole script into a file per line, and attach them to the storyboard. */
export async function importAudio(audio: string, opts: ImportOptions): Promise<ImportResult> {
  if (!opts.storyboard && !opts.lines) throw new Error("Give --storyboard or --lines <n>: the audio is cut into one file per narration line.");
  const file = resolve(audio);
  let count = opts.lines ?? 0;
  let outDir = opts.out;
  let storyboardPath: string | undefined;
  if (opts.storyboard) {
    const { sb, path } = await loadStoryboard(opts.storyboard);
    storyboardPath = path;
    count = sb.narration.length;
    if (count === 0) throw new Error("The storyboard has no narration lines.");
    outDir ??= join(dirname(path), "narration-audio");
  }
  outDir ??= join(dirname(file), `${basename(file, extname(file))}-lines`);
  const r = await splitAudio(file, count, resolve(outDir), { noiseDb: opts.noiseDb, minSilence: opts.minSilence });
  if (storyboardPath) await attachAudio(storyboardPath, r.files);
  return { files: r.files, attached: !!storyboardPath, warnings: r.warnings };
}
