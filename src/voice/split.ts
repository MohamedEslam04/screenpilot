import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/exec.js";
import { probeDuration } from "../util/media.js";
import { mapLimit } from "../util/pool.js";

// One recording of the whole script (from a web TTS) cut into one clip per
// narration line, at the pauses between lines.

export interface Silence {
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
}

/** `silence_start` / `silence_end` lines of ffmpeg's silencedetect filter. */
export function parseSilences(stderr: string, duration: number): Silence[] {
  const out: Silence[] = [];
  let open: number | undefined;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (e && open !== undefined) {
      out.push({ start: open, end: Number(e[1]) });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ start: open, end: duration });
  return out;
}

/** A silence this close to the start or the end of the file is not a pause between lines. */
const EDGE = 0.1;
/** The next-longest pause this close to the shortest one used makes the split a guess. */
const AMBIGUOUS = 0.8;

/**
 * Pick the `count - 1` longest pauses between lines and return the speech
 * between them, trimmed of silence and padded by `pad` seconds. Throws when the
 * recording has too few pauses.
 */
export function planSplit(silences: Silence[], duration: number, count: number, pad = 0.05): { segments: Segment[]; warnings: string[] } {
  const first = silences[0];
  const last = silences[silences.length - 1];
  const hasLead = !!first && first.start <= EDGE;
  const hasTail = !!last && last.end >= duration - EDGE && !(hasLead && first === last);
  const lead = hasLead ? first!.end : 0;
  const tail = hasTail ? last!.start : duration;
  const inner = silences.filter((s) => !(hasLead && s === first) && !(hasTail && s === last));

  const need = count - 1;
  if (inner.length < need) {
    throw new Error(
      `Splitting into ${count} lines needs ${need} pauses between lines, found ${inner.length}. ` +
        `Leave a longer pause (or a blank line) between lines when generating the audio, or try a smaller --min-silence.`,
    );
  }
  const len = (s: Silence) => s.end - s.start;
  const ranked = [...inner].sort((a, b) => len(b) - len(a) || a.start - b.start);
  const chosen = ranked.slice(0, need).sort((a, b) => a.start - b.start);

  const warnings: string[] = [];
  const next = ranked[need];
  if (need > 0 && next && len(next) >= AMBIGUOUS * len(ranked[need - 1]!)) {
    warnings.push(
      `A ${len(next).toFixed(2)}s pause at ${next.start.toFixed(1)}s is almost as long as the ${len(ranked[need - 1]!).toFixed(2)}s pause used to split. ` +
        `Check that the lines were not cut in the wrong place.`,
    );
  }

  const segments: Segment[] = [];
  for (let k = 0; k < count; k++) {
    const start = k === 0 ? lead : chosen[k - 1]!.end;
    const end = k === count - 1 ? tail : chosen[k]!.start;
    if (end - start < 0.2) throw new Error(`Line ${k + 1} would be only ${Math.max(0, end - start).toFixed(2)}s long: the pauses do not match the lines.`);
    segments.push({ start: Math.max(0, start - pad), end: Math.min(duration, end + pad) });
  }
  return { segments, warnings };
}

export interface SplitOptions {
  /** Level under which sound counts as silence. Default -35 (dB). */
  noiseDb?: number;
  /** Shortest pause that counts, in seconds. Default 0.4; smaller values are tried when there are too few pauses. */
  minSilence?: number;
}

export interface SplitResult {
  /** One WAV per line, in speaking order: 01.wav, 02.wav, ... */
  files: string[];
  segments: Segment[];
  warnings: string[];
}

export async function splitAudio(file: string, count: number, outDir: string, opts: SplitOptions = {}): Promise<SplitResult> {
  if (count < 1) throw new Error("count must be at least 1");
  const duration = await probeDuration(file);
  const noise = opts.noiseDb ?? -35;
  const base = opts.minSilence ?? 0.4;
  const ladder = [base, base * 0.6, base * 0.4];

  let plan: ReturnType<typeof planSplit> | undefined;
  let used = base;
  let failure: unknown;
  for (const d of ladder) {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${noise}dB:d=${d}`, "-f", "null", "-"]);
    try {
      plan = planSplit(parseSilences(stderr, duration), duration, count);
      used = d;
      break;
    } catch (e) {
      failure ??= e;
    }
  }
  if (!plan) throw failure;
  const warnings = [...plan.warnings];
  if (used !== base) warnings.unshift(`Few pauses at ${base}s; split with pauses of ${used.toFixed(2)}s and longer.`);

  await mkdir(outDir, { recursive: true });
  const files = plan.segments.map((_, i) => join(outDir, `${String(i + 1).padStart(2, "0")}.wav`));
  await mapLimit(plan.segments, 4, (s, i) =>
    run("ffmpeg", ["-y", "-loglevel", "error", "-ss", s.start.toFixed(3), "-i", file, "-t", (s.end - s.start).toFixed(3), "-c:a", "pcm_s16le", files[i]!]),
  );
  return { files, segments: plan.segments, warnings };
}
