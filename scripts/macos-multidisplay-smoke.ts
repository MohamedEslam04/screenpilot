// Retina + multi-display check for a real macOS desktop:
//   pnpm smoke:macos-multidisplay
// CI (.github/workflows/macos-multidisplay.yml) first starts scripts/macos/vdisplay.swift,
// which adds a virtual 1512x982-point HiDPI display (3024x1964 px) right of the
// main display, 100 pt lower. This script then checks what screenpilot does
// with two displays of different density. Moves the real pointer and types.
// Writes smoke-report/multidisplay-report.json; exits 1 if any check failed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { displays } from "../src/platform/macos/desktop.js";
import type { Display } from "../src/platform/macos/geometry.js";
import { MacInjector } from "../src/platform/macos/injector.js";
import { quartz, type Quartz } from "../src/platform/macos/quartz.js";
import { getDesktop, type WindowInfo } from "../src/platform/index.js";
import { screenshot } from "../src/drive/see.js";
import { captureScale, layout, listAvfoundationScreens, screencaptureArgs } from "../src/record/backends/macos-avfoundation.js";
import { startRecording } from "../src/record/index.js";
import { run } from "../src/util/exec.js";
import { probeVideo } from "../src/util/media.js";

const OUT = resolve("smoke-report");
const WANT = { w: 1512, h: 982, scale: 2, offsetY: 100 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stderr.write(`multidisplay: ${m}\n`);

class Blocked extends Error {}
interface Result {
  name: string;
  ok: boolean;
  blocked?: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];
const CHECK_TIMEOUT_MS = 90_000;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  let ok = true;
  let blocked = false;
  let detail: string;
  log(`start ${name}`);
  let timer: NodeJS.Timeout | undefined;
  try {
    detail = await Promise.race([fn(), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS)))]);
  } catch (err) {
    blocked = err instanceof Blocked;
    ok = blocked;
    detail = err instanceof Error ? err.message : String(err);
  }
  clearTimeout(timer);
  results.push({ name, ok, ...(blocked ? { blocked } : {}), detail, ms: Date.now() - t0 });
  log(`${blocked ? "BLOCKED" : ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

const rectText = (w: { x: number; y: number; w: number; h: number }) => `${w.x},${w.y} ${w.w}x${w.h}`;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

async function waitWindow(app: string, timeoutMs = 15_000): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await (await getDesktop()).listWindows()).find((w) => w.resourceClass === app);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no ${app} window appeared`);
    await sleep(300);
  }
}
const refresh = async (id: string) => {
  const w = (await (await getDesktop()).listWindows()).find((x) => x.id === id);
  if (!w) throw new Error(`window ${id} is gone`);
  return w;
};

interface Ev {
  t: number;
  type: string;
  x: number;
  y: number;
}
function readEvents(file: string | null): Ev[] {
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  let q: Quartz | undefined;
  let ds: Display[] = [];
  let retina: Display | undefined;
  let main: Display | undefined;
  let trusted = false;
  let capture = false;
  let textEdit: WindowInfo | undefined;
  const needAx = () => {
    if (!trusted) throw new Blocked("Accessibility is not granted to this process");
  };
  const needCapture = () => {
    if (!capture) throw new Blocked("Screen Recording is not granted to this process");
  };

  await check("virtual display report (vdisplay)", async () => {
    const rep = JSON.parse(readFileSync(join(OUT, "vdisplay.json"), "utf8")) as { id: number; applied: boolean; active: { id: number; virtual: boolean; x: number; y: number; w: number; h: number; mode?: { pixelW: number; pixelH: number } }[] };
    const v = rep.active.find((d) => d.virtual);
    if (!v) throw new Error("vdisplay did not report a virtual display");
    return `id ${rep.id}, applySettings ${rep.applied}, bounds ${v.x},${v.y} ${v.w}x${v.h}, pixels ${v.mode?.pixelW}x${v.mode?.pixelH}; active ${rep.active.length}`;
  });

  await check("displays: both listed with point rects, pixels and scale", async () => {
    q = await quartz();
    trusted = q.axTrusted();
    capture = q.screenCaptureAllowed();
    ds = await displays();
    if (ds.length < 2) throw new Error(`expected 2+ displays, got ${ds.length}: ${ds.map((d) => d.screen.name).join(", ")}`);
    retina = ds.find((d) => d.screen.w === WANT.w && d.screen.h === WANT.h);
    if (!retina) throw new Error(`no ${WANT.w}x${WANT.h} pt display: ${ds.map((d) => `${d.screen.name} ${rectText(d.screen)} ${d.pixelW}x${d.pixelH}`).join("; ")}`);
    main = ds.find((d) => d.screen.x === 0 && d.screen.y === 0);
    if (!main) throw new Error("no main display at 0,0");
    const bad: string[] = [];
    if (retina.pixelW !== WANT.w * 2 || retina.pixelH !== WANT.h * 2) bad.push(`retina pixels ${retina.pixelW}x${retina.pixelH}, want ${WANT.w * 2}x${WANT.h * 2}`);
    if (retina.scale !== WANT.scale) bad.push(`retina scale ${retina.scale}`);
    if (retina.screen.x !== main.screen.w) bad.push(`retina x ${retina.screen.x}, want ${main.screen.w} (right of main)`);
    if (!near(retina.screen.y, WANT.offsetY, 4)) bad.push(`retina y ${retina.screen.y}, want ${WANT.offsetY}`);
    if (main.pixelW !== main.screen.w * main.scale) bad.push("main pixel/scale mismatch");
    if (new Set(ds.map((d) => d.screen.name)).size !== ds.length) bad.push(`duplicate names: ${ds.map((d) => d.screen.name).join(", ")}`);
    if (bad.length) throw new Error(bad.join("; "));
    return ds.map((d) => `[${d.index}] "${d.screen.name}" ${rectText(d.screen)} pt, ${d.pixelW}x${d.pixelH} px (x${d.scale}), work ${rectText(d.work)}`).join("; ");
  });

  await check("avfoundation lists an extra Capture screen", async () => {
    const screens = await listAvfoundationScreens();
    if (screens.length !== ds.length) throw new Error(`ffmpeg lists ${screens.length} screens, Quartz ${ds.length}: ${JSON.stringify(screens)}`);
    return screens.map((s) => `device ${s.device} = Capture screen ${s.screen}`).join("; ");
  });

  await check("avfoundation delivers the Retina display in full pixels", async () => {
    needCapture();
    if (!retina) throw new Error("needs the Retina display");
    const png = join(OUT, "md-avf-retina.png");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-i", `Capture screen ${retina.index}:none`, "-frames:v", "1", "-y", png]);
    const info = await probeVideo(png);
    if (info.width !== retina.pixelW || info.height !== retina.pixelH) throw new Error(`avfoundation frame is ${info.width}x${info.height}, display has ${retina.pixelW}x${retina.pixelH} px`);
    return `Capture screen ${retina.index} frame ${info.width}x${info.height}`;
  });

  await check("pointer: CGEvent moves read back within 0.5 pt on both displays", async () => {
    if (!q || ds.length < 2) throw new Error("needs quartz + 2 displays");
    const inj = new MacInjector(q, ds.map((d) => d.screen));
    const start = q.cursor();
    const out: string[] = [];
    let worst = 0;
    // Alternate between displays, including points near the shared edge and the far corner.
    const plan: [Display, number, number][] = [];
    for (const d of [ds[0]!, retina!, ds[0]!, retina!]) for (const [fx, fy] of [[0.25, 0.25], [0.9, 0.7]] as const) plan.push([d, fx, fy]);
    plan.push([retina!, 0.001, 0.5], [retina!, 0.5, 0.999]);
    for (const [d, fx, fy] of plan) {
      const to = { x: d.screen.x + fx * d.screen.w, y: d.screen.y + fy * d.screen.h };
      await inj.moveTo(to.x, to.y);
      await sleep(120);
      const seen = q.cursor();
      const dist = Math.hypot(seen.x - to.x, seen.y - to.y);
      worst = Math.max(worst, dist);
      out.push(`${d === retina ? "R" : "M"}(${to.x.toFixed(1)},${to.y.toFixed(1)})=>(${seen.x.toFixed(1)},${seen.y.toFixed(1)}) ${dist.toFixed(2)}`);
    }
    await inj.moveTo(start.x, start.y);
    if (worst > 0.5) {
      const msg = `worst error ${worst.toFixed(2)} pt: ${out.join("; ")}`;
      throw trusted ? new Error(msg) : new Blocked(`${msg} (CGEventPost needs Accessibility here)`);
    }
    return `worst ${worst.toFixed(3)} pt over ${plan.length} moves; ${out.slice(0, 4).join("; ")}`;
  });

  await check("textedit: focus + 16:9 fit on the Retina display", async () => {
    needAx();
    if (!retina) throw new Error("needs the Retina display");
    const dir = mkdtempSync(join(tmpdir(), "smoke-te-"));
    const file = join(dir, "smoke.txt");
    writeFileSync(file, "");
    await run("open", ["-a", "TextEdit", file]);
    textEdit = await waitWindow("TextEdit");
    const desktop = await getDesktop();
    await desktop.focusWindow(textEdit.id, { screen: retina.screen.name });
    await sleep(700);
    textEdit = await refresh(textEdit.id);
    const aspect = textEdit.w / textEdit.h;
    const work = retina.work;
    const inside = textEdit.x >= work.x - 2 && textEdit.y >= work.y - 2 && textEdit.x + textEdit.w <= work.x + work.w + 2 && textEdit.y + textEdit.h <= work.y + work.h + 2;
    if (!inside) throw new Error(`window ${rectText(textEdit)} is outside the Retina work area ${rectText(work)}`);
    if (Math.abs(aspect - 16 / 9) > 0.06) throw new Error(`aspect ${aspect.toFixed(3)} is not 16:9 (${rectText(textEdit)})`);
    if (textEdit.output !== retina.screen.name) throw new Error(`window reports output "${textEdit.output}", want "${retina.screen.name}"`);
    // Fit (restore round trip) must also land on that display.
    await desktop.focusWindow(textEdit.id, { x: retina.work.x + 50, y: retina.work.y + 50, w: 600, h: 500 });
    await sleep(400);
    const before = await refresh(textEdit.id);
    const fit = await desktop.fitWindow("TextEdit", 16 / 9);
    await sleep(400);
    const fitted = await refresh(textEdit.id);
    await fit.restore();
    await sleep(600);
    const after = await refresh(textEdit.id);
    const off = (["x", "y", "w", "h"] as const).map((k) => Math.abs(after[k] - before[k]));
    if (off.some((o) => o > 4)) throw new Error(`restore off by ${off.join("/")} pt: before ${rectText(before)}, after ${rectText(after)}`);
    if (fitted.output !== retina.screen.name) throw new Error(`fitted window is on "${fitted.output}"`);
    if (Math.abs(fitted.w / fitted.h - 16 / 9) > 0.06) throw new Error(`fitted aspect ${(fitted.w / fitted.h).toFixed(3)} (${rectText(fitted)})`);
    return `focused ${rectText(textEdit)} (aspect ${aspect.toFixed(3)}) on ${textEdit.output}; fit ${rectText(fitted)}; restored ${rectText(after)}`;
  });
  if (capture) await run("screencapture", ["-x", "-C", join(OUT, "md-01-textedit-on-retina.png")]).catch(() => {});

  await check("textedit: close", async () => {
    if (!textEdit) throw new Error("no TextEdit window");
    process.kill(textEdit.pid, "SIGTERM");
    await sleep(800);
    return `killed pid ${textEdit.pid}`;
  });

  await check("screenshot of the Retina display has the right pixel size", async () => {
    needCapture();
    if (!retina) throw new Error("needs the Retina display");
    const png = join(OUT, "md-retina.png");
    await run("screencapture", screencaptureArgs(retina.screen, png));
    const info = await probeVideo(png);
    if (info.width !== retina.pixelW || info.height !== retina.pixelH) throw new Error(`screencapture is ${info.width}x${info.height}, want ${retina.pixelW}x${retina.pixelH}`);
    // The tool's own screenshot (downscaled to a width) must keep the display's aspect ratio.
    const r = await screenshot(ds.map((d) => d.screen), { outDir: join(OUT, "md-screens"), width: 960, only: retina.screen.name });
    const s = await probeVideo(r.shots[0]!.file);
    const wantH = Math.round((960 * retina.screen.h) / retina.screen.w);
    if (s.width !== 960 || Math.abs(s.height - wantH) > 2) throw new Error(`screenshot() gave ${s.width}x${s.height}, want 960x${wantH}`);
    return `raw ${info.width}x${info.height}; screenshot() ${s.width}x${s.height}`;
  });

  /** Record for ~3 s while the pointer visits `points` (global pt); return the video info and normalized events. */
  async function record(tag: string, opts: { screens: "all" | string[] }, points: { x: number; y: number }[]) {
    if (!q) throw new Error("needs quartz");
    const inj = new MacInjector(q, ds.map((d) => d.screen));
    const start = q.cursor();
    const rec = await startRecording({ dir: join(OUT, `md-recording-${tag}`), screens: opts.screens, recorder: "native", log });
    await sleep(500);
    for (const p of points) {
      await inj.moveTo(p.x, p.y);
      await sleep(450);
    }
    await sleep(500);
    const r = await rec.stop();
    await inj.moveTo(start.x, start.y);
    const info = await probeVideo(r.video);
    return { r, info, events: readEvents(r.events) };
  }

  /** The recorded pointer positions near `at` (normalized 0..1 of the video) after moving there. */
  const sawPointer = (events: Ev[], want: { x: number; y: number }, tol = 0.004) => events.some((e) => e.type === "move" && near(e.x, want.x, tol) && near(e.y, want.y, tol));

  await check("recording --screens all: canvas layout and pointer normalization", async () => {
    needCapture();
    if (!retina || !main) throw new Error("needs both displays");
    const inputs = ds.map((d) => ({ index: d.index, rect: d.screen, scale: d.scale }));
    const sc = captureScale(inputs);
    const want = layout(inputs, sc);
    const u = { x: Math.min(...ds.map((d) => d.screen.x)), y: Math.min(...ds.map((d) => d.screen.y)), w: 0, h: 0 };
    u.w = Math.max(...ds.map((d) => d.screen.x + d.screen.w)) - u.x;
    u.h = Math.max(...ds.map((d) => d.screen.y + d.screen.h)) - u.y;
    const pm = { x: main.screen.x + main.screen.w * 0.5, y: main.screen.y + main.screen.h * 0.5 };
    const pr = { x: retina.screen.x + retina.screen.w * 0.25, y: retina.screen.y + retina.screen.h * 0.75 };
    const { r, info, events } = await record("all", { screens: "all" }, [pm, pr]);
    if (!(r.duration > 1.5)) throw new Error(`recording too short: ${r.duration}s`);
    // Expected from the documented rules: common density = min(sharpest, 4096/union w, 2304/union h).
    if (info.width !== want.w || info.height !== want.h) throw new Error(`video is ${info.width}x${info.height}, expected ${want.w}x${want.h} (scale ${sc.toFixed(3)})`);
    // Content, not just size: the Retina display's menu bar must sit at its place, the gap above it must be black.
    const mean = (x: number, y: number, w: number, h: number) =>
      new Promise<number>((res) => {
        const f = ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", r.video, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},scale=1:1:flags=area,format=gray`, "-f", "rawvideo", "-"];
        const p = spawn("ffmpeg", f, { stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        p.stdout.on("data", (d: Buffer) => chunks.push(d));
        p.once("close", () => res(Buffer.concat(chunks)[0] ?? -1));
      });
    const pl = want.places[1]!;
    const barY = pl.y + 6;
    const bar = await mean(pl.x + Math.round(pl.w * 0.3), barY, Math.round(pl.w * 0.2), 10);
    const gap = pl.y > 24 ? await mean(pl.x + 20, 4, 200, pl.y - 12) : 0;
    if (bar < 120) throw new Error(`Retina menu bar region at ${pl.x},${barY} is dark (mean ${bar}): the display is not where the layout says`);
    if (gap > 30) throw new Error(`gap above the Retina display is not black (mean ${gap})`);
    const nm = { x: (pm.x - u.x) / u.w, y: (pm.y - u.y) / u.h };
    const nr = { x: (pr.x - u.x) / u.w, y: (pr.y - u.y) / u.h };
    const bad: string[] = [];
    if (!sawPointer(events, nm)) bad.push(`no pointer event at main ${nm.x.toFixed(4)},${nm.y.toFixed(4)}`);
    if (!sawPointer(events, nr)) bad.push(`no pointer event at retina ${nr.x.toFixed(4)},${nr.y.toFixed(4)}`);
    if (bad.length) throw new Error(`${bad.join("; ")}; ${events.length} events, sample ${JSON.stringify(events.slice(-3))}`);
    return `${info.width}x${info.height} (menu bar mean ${bar}, gap mean ${gap}) at ${sc.toFixed(3)} px/pt (union ${rectText(u)} pt, places ${want.places.map(rectText).join(" | ")}); pointer main→(${nm.x.toFixed(3)},${nm.y.toFixed(3)}) retina→(${nr.x.toFixed(3)},${nr.y.toFixed(3)}) ok; ${r.warnings.join(" | ") || "no warnings"}`;
  });
  if (capture) await run("screencapture", ["-x", "-C", join(OUT, "md-02-end.png")]).catch(() => {});

  await check("recording the Retina display alone: full pixels + pointer", async () => {
    needCapture();
    if (!retina || !main) throw new Error("needs both displays");
    const sc = captureScale([{ index: retina.index, rect: retina.screen, scale: retina.scale }]);
    const wantW = Math.round(Math.min(retina.pixelW, 4096) / 2) * 2;
    const pr = { x: retina.screen.x + retina.screen.w * 0.3, y: retina.screen.y + retina.screen.h * 0.6 };
    const pm = { x: main.screen.x + 100, y: main.screen.y + 100 };
    const { info, events } = await record("retina", { screens: [retina.screen.name] }, [pm, pr]);
    if (info.width !== wantW || info.height !== retina.pixelH) throw new Error(`video is ${info.width}x${info.height}, want ${retina.pixelW}x${retina.pixelH} (captureScale ${sc})`);
    if (!sawPointer(events, { x: 0.3, y: 0.6 })) throw new Error(`no pointer event at 0.3,0.6; ${events.length} events, sample ${JSON.stringify(events.slice(-3))}`);
    // The pointer on the other display must be dropped, not clamped onto this one.
    const offscreen = events.filter((e) => e.x < 0 || e.x > 1 || e.y < 0 || e.y > 1);
    if (offscreen.length) throw new Error(`${offscreen.length} events outside 0..1`);
    return `${info.width}x${info.height} (scale ${sc}); pointer at (0.3,0.6) found, ${events.length} events all inside 0..1`;
  });
}

try {
  await main();
} catch (err) {
  results.push({ name: "smoke script", ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err), ms: 0 });
}
const failed = results.filter((r) => !r.ok);
const blocked = results.filter((r) => r.blocked);
writeFileSync(join(OUT, "multidisplay-report.json"), `${JSON.stringify({ ok: failed.length === 0, platform: process.platform, arch: process.arch, checks: results }, null, 2)}\n`);
log(`${results.length - failed.length - blocked.length}/${results.length} checks passed, ${blocked.length} blocked by macOS permissions; report in ${OUT}`);
process.exit(failed.length ? 1 : 0);
