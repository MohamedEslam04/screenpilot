import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In a packaged build (desktop extension, release tarball) ffmpeg/ffprobe sit
 * in bin/ next to the code; put them first on PATH so every child process
 * (including the renderer's own ffmpeg calls) finds them.
 */
export function useBundledTools(entryUrl: string): void {
  const bin = join(dirname(fileURLToPath(entryUrl)), "..", "bin");
  if (existsSync(bin)) process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}
