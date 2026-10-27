// End-to-end check of the generic Wayland "portal" backend on a real wlroots
// compositor (CI: headless sway + xdg-desktop-portal-wlr + PipeWire):
//   scripts/wayland-session.sh pnpm smoke:wayland
// The session script creates two outputs, HEADLESS-1 1280x720 at 0,0 and
// HEADLESS-2 1024x768 at 1280,0. Writes wayland-smoke-report/report.json;
// exits 1 if any check failed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { doctor } from "../src/doctor.js";
import { Driver } from "../src/drive/index.js";
import { detectDesktop, getDesktop } from "../src/platform/index.js";
import { startRecording } from "../src/record/index.js";
import { run } from "../src/util/exec.js";

const OUT = resolve("wayland-smoke-report");
const EXPECTED = [
  { name: "HEADLESS-1", x: 0, y: 0, w: 1280, h: 720 },
  { name: "HEADLESS-2", x: 1280, y: 0, w: 1024, h: 768 },
];
const log = (m: string) => process.stderr.write(`smoke: ${m}\n`);

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  let ok = true;
  let detail: string;
  try {
    detail = await fn();
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : String(err);
  }
  results.push({ name, ok, detail, ms: Date.now() - t0 });
  log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

/** Fails unless ffmpeg decodes every frame; returns the video size and frame count. */
async function probe(file: string): Promise<{ w: number; h: number; frames: number }> {
  await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", file]);
  const s = (JSON.parse(stdout) as { streams: { width: number; height: number; nb_read_frames: string }[] }).streams[0];
  if (!s) throw new Error("no video stream");
  return { w: s.width, h: s.height, frames: Number(s.nb_read_frames) };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  await check("desktop detection → portal", async () => {
    const d = detectDesktop();
    if (d.id !== "portal") throw new Error(`expected portal, got ${d.id} (${d.reason})`);
    return `${d.id}: ${d.reason}`;
  });

  await check("monitors from swaymsg", async () => {
    const screens = await (await getDesktop()).screens();
    const got = screens.map((s) => ({ name: s.name, x: s.x, y: s.y, w: s.w, h: s.h }));
    if (JSON.stringify(got) !== JSON.stringify(EXPECTED)) throw new Error(`expected ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(got)}`);
    return got.map((s) => `${s.name} ${s.w}x${s.h}+${s.x}+${s.y}`).join("; ");
  });

  await check("doctor: per-capability lines", async () => {
    const report = await doctor();
    const by = (n: string) => report.checks.find((c) => c.name === n);
    const line = (n: string) => `${n}: ${by(n)?.skipped ? "skipped, " : ""}${by(n)?.detail}`;
    const rec = by("can record (native)");
    if (!rec?.ok || rec.skipped) throw new Error(`record not ok: ${rec?.detail}`);
    const drive = by("can drive (input injection)");
    if (!drive?.skipped || !/not supported/i.test(drive.detail) || !/RemoteDesktop/.test(drive.detail)) throw new Error(`drive should be "not supported": ${drive?.detail}`);
    const win = by("window control");
    if (!win?.skipped || !/not available/i.test(win.detail)) throw new Error(`window control should be "not available": ${win?.detail}`);
    const wins = by("windows");
    if (!wins?.skipped) throw new Error(`windows should be skipped: ${wins?.detail}`);
    for (const n of ["desktop", "monitors"]) if (!by(n)?.ok) throw new Error(`${n} failed: ${by(n)?.detail}`);
    return [line("desktop"), line("monitors"), line("can record (native)"), line("can drive (input injection)"), line("window control"), line("windows")].join(" | ");
  });

  await check("driving gives a clear 'not supported' error", async () => {
    try {
      const d = await Driver.open({ log });
      await d.close();
    } catch (err) {
      const msg = (err as Error).message;
      if (!/not supported/i.test(msg) || !/RemoteDesktop/.test(msg)) throw new Error(`unclear error: ${msg}`);
      return msg;
    }
    throw new Error("Driver.open succeeded; expected a not-supported error");
  });

  await check("native recording 3 s, --screens all (ScreenCast portal + GStreamer)", async () => {
    const rec = await startRecording({ dir: join(OUT, "recording-all"), screens: "all", recorder: "native", log });
    await new Promise((r) => setTimeout(r, 3000));
    const r = await rec.stop();
    if (!(r.duration > 2)) throw new Error(`recording too short: ${r.duration}s (${r.video})`);
    const p = await probe(r.video);
    // Both outputs side by side: 1280 + 1024 wide, the taller one high.
    if (p.w !== 2304 || p.h !== 768) throw new Error(`expected 2304x768, got ${p.w}x${p.h}`);
    if (p.frames < 30) throw new Error(`only ${p.frames} frames`);
    return `${r.video} ${p.w}x${p.h}, ${p.frames} frames, ${r.duration.toFixed(2)}s, warnings ${r.warnings.length}`;
  });
}

try {
  await main();
} catch (err) {
  results.push({ name: "smoke script", ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err), ms: 0 });
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2)}\n`);
log(`${results.length - failed.length}/${results.length} checks passed; report in ${OUT}`);
process.exit(failed.length ? 1 : 0);
