import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDuration } from "../src/util/media.js";
import { parseSilences, planSplit, splitAudio } from "../src/voice/split.js";

describe("parseSilences", () => {
  it("reads ffmpeg silencedetect output", () => {
    const err = [
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.5",
      "[silencedetect @ 0x1] silence_start: 2.25",
      "[silencedetect @ 0x1] silence_end: 3.5 | silence_duration: 1.25",
    ].join("\n");
    expect(parseSilences(err, 10)).toEqual([
      { start: 0, end: 0.5 },
      { start: 2.25, end: 3.5 },
    ]);
  });

  it("closes a silence that runs to the end and clamps a negative start", () => {
    const err = "silence_start: -0.002\nsilence_end: 0.4 | silence_duration: 0.4\nsilence_start: 8.5";
    expect(parseSilences(err, 10)).toEqual([
      { start: 0, end: 0.4 },
      { start: 8.5, end: 10 },
    ]);
  });
});

describe("planSplit", () => {
  // speech 0.5-2, pause 2-3, speech 3-4.5, pause 4.5-4.8 (short, inside a line), speech 4.8-6, pause 6-7.2, speech 7.2-9, silence to 10
  const silences = [
    { start: 0, end: 0.5 },
    { start: 2, end: 3 },
    { start: 4.5, end: 4.8 },
    { start: 6, end: 7.2 },
    { start: 9, end: 10 },
  ];

  it("cuts at the longest pauses and trims the speech, with a small pad", () => {
    const { segments, warnings } = planSplit(silences, 10, 3, 0.05);
    expect(segments).toHaveLength(3);
    expect(segments[0]!.start).toBeCloseTo(0.45, 5);
    expect(segments[0]!.end).toBeCloseTo(2.05, 5);
    expect(segments[1]!.start).toBeCloseTo(2.95, 5);
    expect(segments[1]!.end).toBeCloseTo(6.05, 5);
    expect(segments[2]!.start).toBeCloseTo(7.15, 5);
    expect(segments[2]!.end).toBeCloseTo(9.05, 5);
    expect(warnings).toEqual([]);
  });

  it("handles one line", () => {
    const { segments } = planSplit(silences, 10, 1, 0.05);
    expect(segments).toEqual([{ start: expect.closeTo(0.45, 5), end: expect.closeTo(9.05, 5) }]);
  });

  it("starts at 0 and ends at the duration when there is no lead or tail silence", () => {
    const { segments } = planSplit([{ start: 2, end: 3 }], 6, 2, 0.05);
    expect(segments[0]!.start).toBe(0);
    expect(segments[1]!.end).toBe(6);
  });

  it("fails and says what was found when there are too few pauses", () => {
    expect(() => planSplit(silences, 10, 6, 0.05)).toThrow(/needs 5 pauses.*found 3/s);
  });

  it("warns when the next pause is almost as long as the shortest chosen one", () => {
    const close = [
      { start: 2, end: 3 },
      { start: 5, end: 5.9 }, // 0.9 vs the chosen 1.0 pause
      { start: 8, end: 9 },
    ];
    const { warnings } = planSplit(close, 12, 3, 0.05);
    expect(warnings.join(" ")).toMatch(/almost as long/);
  });
});

function speechWithPauses(file: string, parts: ({ speech: number } | { pause: number })[]): void {
  const args = ["-y", "-loglevel", "error"];
  parts.forEach((p) => {
    args.push("-f", "lavfi", "-i", "speech" in p ? `sine=frequency=300:sample_rate=24000:duration=${p.speech}` : `anullsrc=r=24000:cl=mono:d=${p.pause}`);
  });
  args.push("-filter_complex", `${parts.map((_, i) => `[${i}:a]`).join("")}concat=n=${parts.length}:v=0:a=1[o]`, "-map", "[o]", file);
  execFileSync("ffmpeg", args);
}

describe("splitAudio", () => {
  it("cuts one recording into one file per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-split-"));
    const src = join(dir, "all.wav");
    speechWithPauses(src, [{ speech: 1.5 }, { pause: 1.2 }, { speech: 1 }, { pause: 0.3 }, { speech: 1 }, { pause: 1.2 }, { speech: 2 }]);
    const r = await splitAudio(src, 3, join(dir, "out"));
    expect(r.files.map((f) => basename(f))).toEqual(["01.wav", "02.wav", "03.wav"]);
    const d = await Promise.all(r.files.map(probeDuration));
    expect(d[0]).toBeGreaterThan(1.45);
    expect(d[0]).toBeLessThan(1.75);
    expect(d[1]).toBeGreaterThan(2.2); // the short pause stays inside line 2: 1 + 0.3 + 1
    expect(d[1]).toBeLessThan(2.5);
    expect(d[2]).toBeGreaterThan(1.95);
    expect(d[2]).toBeLessThan(2.25);
  });

  it("tells how many pauses it found when the count does not match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-split-"));
    const src = join(dir, "all.wav");
    speechWithPauses(src, [{ speech: 1 }, { pause: 1 }, { speech: 1 }]);
    await expect(splitAudio(src, 4, join(dir, "out"))).rejects.toThrow(/needs 3 pauses/);
  });
});
