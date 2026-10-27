// End-to-end check for a real macOS desktop (GitHub runner or your Mac):
//   pnpm smoke:macos
// Moves the real pointer and types, so keep your hands off. Writes
// smoke-report/report.json and screenshots; exits 1 if any check failed.
// Checks that need a privacy permission this process does not have
// (Accessibility, Screen Recording: TCC) are reported as "blocked", not
// failed: a CI runner cannot click those switches.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Driver } from "../src/drive/index.js";
import { screenshot } from "../src/drive/see.js";
import { locate, openBrowser, withPage } from "../src/drive/web.js";
import { displays } from "../src/platform/macos/desktop.js";
import type { Display } from "../src/platform/macos/geometry.js";
import { MacInjector } from "../src/platform/macos/injector.js";
import { hostApp } from "../src/platform/macos/permissions.js";
import { quartz, type Quartz } from "../src/platform/macos/quartz.js";
import { getDesktop, type WindowInfo } from "../src/platform/index.js";
import { captureScale, layout, listAvfoundationScreens } from "../src/record/backends/macos-avfoundation.js";
import { startRecording } from "../src/record/index.js";
import { run } from "../src/util/exec.js";
import { probeVideo } from "../src/util/media.js";

const OUT = resolve("smoke-report");
const TYPED = "Hello 123 مرحبا 😀";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stderr.write(`smoke: ${m}\n`);

/** A check that cannot run because macOS has not granted a permission (not a bug). */
class Blocked extends Error {}

interface Result {
  name: string;
  ok: boolean;
  blocked?: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];

/** One isolated check: a throw fails only this check (a Blocked throw only marks it blocked). */
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  let ok = true;
  let blocked = false;
  let detail: string;
  try {
    detail = await fn();
  } catch (err) {
    blocked = err instanceof Blocked;
    ok = blocked;
    detail = err instanceof Error ? err.message : String(err);
  }
  results.push({ name, ok, ...(blocked ? { blocked } : {}), detail, ms: Date.now() - t0 });
  log(`${blocked ? "BLOCKED" : ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

/** Whole desktop to a PNG for the report (silently skipped without Screen Recording). */
async function shot(name: string, allowed: boolean): Promise<void> {
  if (!allowed) return;
  await run("screencapture", ["-x", "-C", join(OUT, `${name}.png`)]).catch((err) => log(`screenshot ${name} failed: ${(err as Error).message}`));
}

const rectText = (w: { x: number; y: number; w: number; h: number }) => `${w.x},${w.y} ${w.w}x${w.h}`;

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

function writeSmokePage(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-page-"));
  const file = join(dir, "smoke-page.html");
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>smoke</title>
<body style="font:24px sans-serif;padding:40px">
<button id="a" style="font-size:28px;padding:20px 40px">Button A</button>
<button id="b" style="font-size:28px;padding:20px 40px;margin-left:40px">Button B</button>
<script>
window.__clicks = [];
for (const id of ["a", "b"]) document.getElementById(id).addEventListener("click", (e) => window.__clicks.push({ id, trusted: e.isTrusted }));
</script>`,
  );
  return pathToFileURL(file).href;
}

const pbpaste = async () => (await run("pbpaste", [])).stdout;
function pbcopy(text: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    p.once("error", rej);
    p.once("close", () => res());
    p.stdin.end(text);
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  let q: Quartz | undefined;
  let ds: Display[] = [];
  let trusted = false;
  let capture = false;
  let driver: Driver | undefined;
  let textEdit: WindowInfo | undefined;
  const needAx = () => {
    if (!trusted) throw new Blocked("Accessibility is not granted to this process");
  };
  const needCapture = () => {
    if (!capture) throw new Blocked("Screen Recording is not granted to this process");
  };

  await check("desktop is macos", async () => {
    const id = (await getDesktop()).id;
    if (id !== "macos") throw new Error(`desktop id is "${id}"`);
    q = await quartz();
    return `${id} (${process.arch})`;
  });

  await check("displays", async () => {
    ds = await displays();
    if (ds.length === 0) throw new Error("no displays");
    for (const d of ds) {
      const s = d.screen;
      if (!(s.w > 0 && s.h > 0 && s.w < 20_000 && s.h < 20_000)) throw new Error(`odd display rect ${s.name}: ${rectText(s)}`);
      if (!(d.scale >= 1 && d.scale <= 4)) throw new Error(`odd scale ${d.scale} for ${s.name}`);
    }
    return ds.map((d) => `[${d.index}] ${d.screen.name} ${rectText(d.screen)} pt, ${d.pixelW}x${d.pixelH} px (x${d.scale}), work ${rectText(d.work)}`).join("; ");
  });

  await check("permissions", async () => {
    if (!q) throw new Error("needs quartz");
    trusted = q.axTrusted();
    capture = q.screenCaptureAllowed();
    return `host app: ${await hostApp()}; accessibility ${trusted}, screen recording ${capture}, input monitoring ${q.inputMonitoring()}`;
  });
  await shot("01-desktop", capture);

  await check("pointer: CGEvent move + read back", async () => {
    if (!q || !ds[0]) throw new Error("needs quartz + display");
    const s = ds[0].screen;
    const inj = new MacInjector(q, ds.map((d) => d.screen));
    const start = q.cursor();
    const out: string[] = [];
    let worst = 0;
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.5], [0.5, 0.8]] as const) {
      const to = { x: s.x + fx * s.w, y: s.y + fy * s.h };
      await inj.moveTo(to.x, to.y);
      await sleep(150);
      const seen = q.cursor();
      const dist = Math.hypot(seen.x - to.x, seen.y - to.y);
      worst = Math.max(worst, dist);
      out.push(`(${Math.round(to.x)},${Math.round(to.y)}) off by ${dist.toFixed(1)} pt`);
    }
    await inj.moveTo(start.x, start.y);
    if (worst > 1.5) {
      const msg = `pointer did not follow: ${out.join("; ")}`;
      throw trusted ? new Error(msg) : new Blocked(`${msg} (CGEventPost needs Accessibility here)`);
    }
    return `${out.join("; ")}${trusted ? "" : " (posted without Accessibility)"}`;
  });

  await check("avfoundation devices", async () => {
    const screens = await listAvfoundationScreens();
    if (screens.length === 0) throw new Error("ffmpeg lists no avfoundation screens");
    if (screens.length !== ds.length) throw new Error(`ffmpeg lists ${screens.length} screens, Quartz ${ds.length}`);
    return screens.map((s) => `device ${s.device} = Capture screen ${s.screen}`).join("; ");
  });

  await check("window list", async () => {
    const wins = await (await getDesktop()).listWindows();
    return `${wins.length} windows: ${wins.slice(0, 6).map((w) => `${w.resourceClass}${w.active ? "*" : ""} ${rectText(w)} on ${w.output}`).join("; ")}`;
  });

  await check("driver open", async () => {
    needAx();
    driver = await Driver.open({ log });
    return `${driver.screens().length} display(s), cursor ${JSON.stringify(driver.cursor())}`;
  });

  await check("textedit: launch + find window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-te-"));
    const file = join(dir, "smoke.txt");
    writeFileSync(file, "");
    await run("open", ["-a", "TextEdit", file]);
    textEdit = await waitWindow("TextEdit");
    return `window ${textEdit.id} pid ${textEdit.pid} "${textEdit.caption}" ${rectText(textEdit)}`;
  });

  await check("textedit: focus on display at 16:9", async () => {
    needAx();
    const s = ds[0]?.screen;
    if (!textEdit || !s) throw new Error("needs a TextEdit window");
    await (await getDesktop()).focusWindow(textEdit.id, { screen: s.name });
    await sleep(600);
    textEdit = await refresh(textEdit.id);
    const aspect = textEdit.w / textEdit.h;
    const work = ds[0]!.work;
    const inside = textEdit.x >= work.x - 2 && textEdit.y >= work.y - 2 && textEdit.x + textEdit.w <= work.x + work.w + 2 && textEdit.y + textEdit.h <= work.y + work.h + 2;
    if (!inside) throw new Error(`window ${rectText(textEdit)} is outside the work area ${rectText(work)}`);
    if (Math.abs(aspect - 16 / 9) > 0.06) throw new Error(`aspect ${aspect.toFixed(3)} is not 16:9 (${rectText(textEdit)})`);
    if (!textEdit.active) throw new Error("window is not the active one");
    return `${rectText(textEdit)} aspect ${aspect.toFixed(3)}`;
  });
  await shot("02-textedit-focused", capture);

  await check("textedit: fitWindow + restore round trip", async () => {
    needAx();
    if (!textEdit) throw new Error("needs a TextEdit window");
    // Move it off 16:9 first so fitting has something to do.
    await (await getDesktop()).focusWindow(textEdit.id, { x: textEdit.x + 20, y: textEdit.y + 20, w: 600, h: 500 });
    await sleep(400);
    const before = await refresh(textEdit.id);
    const fit = await (await getDesktop()).fitWindow("TextEdit", 16 / 9);
    await sleep(400);
    const fitted = await refresh(textEdit.id);
    await fit.restore();
    await sleep(600);
    const after = await refresh(textEdit.id);
    const off = (["x", "y", "w", "h"] as const).map((k) => Math.abs(after[k] - before[k]));
    if (off.some((o) => o > 4)) throw new Error(`restore off by ${off.join("/")} pt: before ${rectText(before)}, after ${rectText(after)}`);
    textEdit = after;
    return `fitted ${rectText(fitted)}, restored ${rectText(after)}`;
  });

  await check("textedit: type Unicode + clipboard round trip", async () => {
    needAx();
    if (!driver || !textEdit) throw new Error("needs driver + TextEdit window");
    const q = await quartz();
    const notes = [`post-event access ${q.postEventAllowed()}`];
    // The default must work on the first try (the injector warms the keyboard up); the session tap is a diagnostic fallback.
    for (const tap of ["default", "session"]) {
      if (tap === "default") delete process.env.SCREENPILOT_MAC_TAP;
      else process.env.SCREENPILOT_MAC_TAP = tap;
      const w = await refresh(textEdit.id);
      await driver.desktop.focusWindow(w.id);
      await driver.moveToGlobal({ x: w.x + w.w / 2, y: w.y + w.h / 2 }, { dur: 0.3 });
      await driver.click();
      await sleep(300);
      await driver.key("cmd+a");
      await driver.key("backspace");
      await driver.type(TYPED, { cps: 30 });
      await sleep(300);
      await shot(`03-textedit-typed-${tap}`, capture);
      await pbcopy("smoke-sentinel"); // so a failed copy cannot pass
      await driver.key("cmd+a");
      await sleep(150);
      await driver.key("cmd+c");
      await sleep(500);
      const got = (await pbpaste()).replace(/\n$/, "");
      if (got === TYPED) {
        delete process.env.SCREENPILOT_MAC_TAP;
        return `${tap} tap: clipboard matches ${JSON.stringify(TYPED)} (${notes.join("; ")})`;
      }
      notes.push(`${tap} tap: clipboard ${JSON.stringify(got)}`);
    }
    delete process.env.SCREENPILOT_MAC_TAP;
    throw new Error(`typed ${JSON.stringify(TYPED)} never arrived: ${notes.join("; ")}`);
  });

  await check("textedit: close", async () => {
    if (!textEdit) throw new Error("no TextEdit window");
    process.kill(textEdit.pid, "SIGTERM");
    await sleep(800);
    return `killed pid ${textEdit.pid}`;
  });

  await check("demo browser: trusted clicks", async () => {
    needAx();
    const s = ds[0]?.screen;
    if (!driver || !s) throw new Error("needs driver + display");
    await openBrowser({ screen: s, url: writeSmokePage(), log });
    await sleep(800);
    const at: string[] = [];
    for (const sel of ["#a", "#b"]) {
      const r = await locate(sel, driver);
      at.push(`${sel} at ${Math.round(r.x)},${Math.round(r.y)} pt`);
      await driver.moveToGlobal({ x: r.x, y: r.y }, { dur: 0.3 });
      await sleep(150);
      await driver.click();
      await sleep(250);
    }
    await shot("04-browser", capture);
    const clicks = (await withPage((p) => p.evaluate("window.__clicks"))) as { id: string; trusted: boolean }[];
    if (clicks.length !== 2 || !clicks.every((c) => c.trusted)) throw new Error(`expected 2 trusted clicks, got ${JSON.stringify(clicks)} (${at.join(", ")})`);
    return `${at.join(", ")}; clicks: ${clicks.map((c) => `${c.id} trusted=${c.trusted}`).join(", ")}`;
  });

  await check("driver close", async () => {
    await driver?.close();
    return driver ? "closed" : "no driver";
  });

  await check("screenshot (screencapture)", async () => {
    needCapture();
    const r = await screenshot(ds.map((d) => d.screen), { outDir: join(OUT, "screens"), width: 960 });
    if (r.shots.length === 0) throw new Error("no shots");
    const info = await probeVideo(r.shots[0]!.file);
    return `${r.shots.map((x) => `${x.screen} → ${x.file}`).join("; ")} (${info.width}x${info.height})`;
  });

  await check("recording 3 s (avfoundation)", async () => {
    needCapture();
    const rec = await startRecording({ dir: join(OUT, "recording"), screens: "all", recorder: "native", log });
    await sleep(3000);
    const r = await rec.stop();
    if (!(r.duration > 1.5)) throw new Error(`recording too short: ${r.duration}s (${r.video})`);
    const info = await probeVideo(r.video);
    const inputs = ds.map((d) => ({ index: d.index, rect: d.screen, scale: d.scale }));
    const want = layout(inputs, captureScale(inputs));
    if (info.width !== want.w || info.height !== want.h) throw new Error(`video is ${info.width}x${info.height}, expected ${want.w}x${want.h}`);
    return `${r.video} ${r.duration.toFixed(2)}s ${info.width}x${info.height}, events ${r.eventCount}, warnings ${r.warnings.join(" | ") || "none"}`;
  });
  await shot("05-end", capture);
}

try {
  await main();
} catch (err) {
  results.push({ name: "smoke script", ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err), ms: 0 });
}
const failed = results.filter((r) => !r.ok);
const blocked = results.filter((r) => r.blocked);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: failed.length === 0, platform: process.platform, arch: process.arch, checks: results }, null, 2)}\n`);
log(`${results.length - failed.length - blocked.length}/${results.length} checks passed, ${blocked.length} blocked by macOS permissions; report in ${OUT}`);
process.exit(failed.length ? 1 : 0);
