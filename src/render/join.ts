import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probePart } from "../sequence/concat.js";
import { run } from "../util/exec.js";
import { ffmpegFilterScriptFlag } from "../util/media.js";

// Joining render chunks (plans/2026-11-08-auto-chunked-render-cache.md, Task 1 decision):
// the video is copied (every chunk starts on an I-frame), but the audio cannot be:
// each AAC chunk keeps its encoder priming and padding, so a copy join adds ~32 ms
// per join and clicks. The audio of every chunk is decoded, trimmed or padded to
// that chunk's VIDEO length, joined and encoded once, then muxed with the video.

const FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
const f3 = (n: number) => n.toFixed(3);

/** concat demuxer list file. */
export function concatList(files: string[]): string {
  return files.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n") + "\n";
}

/** Filter graph for the joined audio: each chunk's sound exactly as long as its video, silence where it has none. */
export function joinAudioFilter(parts: { duration: number; hasAudio: boolean }[]): string {
  const lines = parts.map((p, i) =>
    p.hasAudio
      ? `[${i}:a]aresample=48000:async=1,${FORMAT},apad,atrim=duration=${f3(p.duration)},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,${FORMAT},atrim=duration=${f3(p.duration)},asetpts=PTS-STARTPTS[a${i}]`,
  );
  lines.push(`${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[aout]`);
  return lines.join(";\n");
}

/** Join rendered chunks (same codec settings, in order) into `output`. */
export async function joinChunks(files: string[], output: string, opts: { workDir: string; log?: (msg: string) => void }): Promise<void> {
  const parts = await Promise.all(files.map(probePart));
  const audio = parts.some((p) => p.hasAudio);
  opts.log?.(`join: ${files.length} chunk(s), video copied${audio ? ", audio encoded once" : ""}`);
  const list = join(opts.workDir, "chunks.txt");
  await writeFile(list, concatList(files));
  const video = join(opts.workDir, "joined-video.mp4");
  const sound = join(opts.workDir, "joined-audio.m4a");
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-an", "-c", "copy", ...(audio ? [video] : ["-movflags", "+faststart", output])]);
    if (!audio) return;
    const filterPath = join(opts.workDir, "chunks-audio.filter");
    await writeFile(filterPath, joinAudioFilter(parts));
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      ...files.flatMap((f) => ["-i", f]),
      await ffmpegFilterScriptFlag(),
      filterPath,
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      sound,
    ]);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", sound, "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", output]);
  } finally {
    await rm(video, { force: true });
    await rm(sound, { force: true });
  }
}
