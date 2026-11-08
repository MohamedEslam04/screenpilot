// Render benchmark: times the same synthetic 40 s 1080p30 recording at several settings.
//   pnpm bench:render
// CPU only (ffmpeg + HyperFrames); it never touches the desktop. Everything is made in a
// temp folder that is deleted at the end. Run it on an idle machine: other work skews the numbers.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { draftFps } from "../src/render/draft.js";
import { renderStoryboard } from "../src/render/index.js";
import { maxWorkers } from "../src/render/workers.js";

const SECONDS = 40;
const FPS = 30;

interface Case {
  name: string;
  quality: "draft" | "looks" | "delivery";
  /** Resolved when the case starts, so "max" follows the memory that is free at that moment. */
  workers: () => number;
}

const cases: Case[] = [
  { name: "delivery, 4 workers", quality: "delivery", workers: () => 4 },
  { name: "delivery, max", quality: "delivery", workers: maxWorkers },
  { name: "draft, 4 workers", quality: "draft", workers: () => 4 },
];

const log = (m: string) => process.stderr.write(`bench: ${m}\n`);

const dir = mkdtempSync(join(tmpdir(), "screenpilot-bench-"));
try {
  log(`making a ${SECONDS} s 1080p${FPS} recording in ${dir}`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=${FPS}:duration=${SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", String(FPS),
    join(dir, "rec.mp4"),
  ]);
  const storyboard = join(dir, "storyboard.json");
  writeFileSync(
    storyboard,
    JSON.stringify({
      source: "rec.mp4",
      output: { width: 1920, height: 1080, fps: FPS },
      captions: [
        { at: 1, dur: 3, text: "Start from the dashboard", position: "bottom", style: "pill" },
        { at: 20, dur: 3, text: "One click to send", style: "callout", x: 0.82, y: 0.9 },
        { at: 34, dur: 3, text: "Done", position: "center", style: "title" },
      ],
      zooms: [
        { at: 5, dur: 3, x: 0.18, y: 0.22, scale: 2 },
        { at: 24, dur: 4, x: 0.82, y: 0.9, scale: 1.8 },
      ],
      highlights: [{ at: 20, dur: 2.5, x: 0.72, y: 0.85, w: 0.2, h: 0.1, label: "Send" }],
    }),
  );

  const rows: { name: string; workers: number; wall: number; out: number; stages: string }[] = [];
  for (const [i, c] of cases.entries()) {
    const workers = c.workers();
    log(`${c.name} (${workers} worker(s))`);
    const stages: string[] = [];
    // Our stage timings ("time cut: 1.23s") are collected; HyperFrames' own phase timings stream to stderr.
    const collect = (m: string) => {
      const t = /^time (\w+): ([\d.]+)s$/.exec(m);
      if (t) stages.push(`${t[1]} ${Number(t[2]).toFixed(1)}s`);
      else log(m);
    };
    const start = performance.now();
    const r = await renderStoryboard(storyboard, {
      output: join(dir, "out.mp4"),
      // A fresh build folder per case, so none of them reuses another's cached cut.
      buildDir: join(dir, `build-${i}`),
      quality: c.quality,
      workers,
      timings: true,
      log: collect,
    });
    rows.push({ name: c.name, workers, wall: (performance.now() - start) / 1000, out: r.plan.duration, stages: stages.join(", ") });
  }

  console.log(`\nmachine: ${cpus().length} cores, ${(totalmem() / 1024 ** 3).toFixed(0)} GB RAM; recording ${SECONDS} s 1080p${FPS}\n`);
  console.log("| Render | Workers | Wall time | Video s per wall s | Frames per s | Stages |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    const draftFrames = r.name.startsWith("draft") ? draftFps(FPS) : FPS;
    console.log(`| ${r.name} | ${r.workers} | ${r.wall.toFixed(0)} s | ${(r.out / r.wall).toFixed(2)} | ${((r.out * draftFrames) / r.wall).toFixed(0)} | ${r.stages} |`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
