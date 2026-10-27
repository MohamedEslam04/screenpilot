// End-to-end check of the X11 backend on a real X server (CI: Xvfb + openbox):
//   xvfb-run -a -s "-screen 0 1280x800x24" sh -c "openbox & pnpm smoke:x11"
// Drives the X pointer and keyboard through XTest, so run it on a throwaway
// display, not your desktop. Writes x11-smoke-report/report.json and
// screenshots; exits 1 if any check failed.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Driver } from "../src/drive/index.js";
import { screenshot } from "../src/drive/see.js";
import { findBrowser, locate, openBrowser, withPage } from "../src/drive/web.js";
import { getDesktop, type WindowInfo } from "../src/platform/index.js";
import type { ScreenInfo } from "../src/record/input/types.js";
import { startRecording } from "../src/record/index.js";
import { performTake } from "../src/take/perform.js";
import { run } from "../src/util/exec.js";

const OUT = resolve("x11-smoke-report");
const TYPED = "Hello مرحبا 123";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stderr.write(`smoke: ${m}\n`);

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];

/** One isolated check: a throw fails only this check. The returned string is its detail. */
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

/** The whole X screen to a PNG (no OBS). */
async function shot(name: string): Promise<void> {
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-i", process.env.DISPLAY ?? ":0", "-frames:v", "1", "-y", join(OUT, `${name}.png`)]);
  } catch (err) {
    log(`screenshot ${name} failed: ${(err as Error).message}`);
  }
}

const rectText = (w: { x: number; y: number; w: number; h: number }) => `${w.x},${w.y} ${w.w}x${w.h}`;

// A Tk window that saves its text on every key release, so typed text can be read back.
const TARGET = `
import sys, tkinter as tk
out = sys.argv[1]
root = tk.Tk(className="SmokeTarget")
root.title("smoke target")
root.geometry("640x400+60+60")
text = tk.Text(root, font=("DejaVu Sans", 18))
text.pack(fill="both", expand=True)
def save(_=None):
    with open(out, "w", encoding="utf-8") as f:
        f.write(text.get("1.0", "end-1c"))
text.bind("<KeyRelease>", save)
root.after(300, text.focus_force)
root.mainloop()
`;

function startTarget(dir: string): { child: ChildProcess; out: string } {
  const script = join(dir, "target.py");
  const out = join(dir, "typed.txt");
  writeFileSync(script, TARGET);
  const child = spawn("python3", [script, out], { stdio: "ignore", env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
  return { child, out };
}

async function waitWindow(d: Driver, cls: string, timeoutMs = 15_000): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await d.desktop.listWindows()).find((w) => w.resourceClass.toLowerCase().includes(cls));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no ${cls} window appeared`);
    await sleep(200);
  }
}

const refresh = async (d: Driver, id: string) => {
  const w = (await d.desktop.listWindows()).find((x) => x.id === id);
  if (!w) throw new Error(`window ${id} is gone`);
  return w;
};

const readTyped = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** Fails unless ffmpeg decodes every frame of the file. */
async function playable(file: string): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
}

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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "x11-smoke-"));
  let driver: Driver | undefined;
  let screen: ScreenInfo | undefined;
  let target: { child: ChildProcess; out: string } | undefined;
  let win: WindowInfo | undefined;

  await check("desktop is x11", async () => {
    const id = (await getDesktop()).id;
    if (id !== "x11") throw new Error(`desktop id is "${id}"`);
    return `${id} on ${process.env.DISPLAY}`;
  });

  await check("monitors (XRandR)", async () => {
    const screens = await (await getDesktop()).screens();
    if (screens.length === 0) throw new Error("no monitors");
    for (const s of screens) if (!(s.w > 0 && s.h > 0)) throw new Error(`odd monitor rect ${s.name}: ${rectText(s)}`);
    screen = screens[0];
    return screens.map((s) => `${s.name} ${rectText(s)}`).join("; ");
  });
  await shot("01-desktop");

  await check("driver open", async () => {
    driver = await Driver.open({ log });
    return `${driver.screens().length} monitor(s)`;
  });

  await check("XTest pointer reaches targets (read back with XQueryPointer)", async () => {
    if (!driver || !screen) throw new Error("needs driver + screen");
    const out: string[] = [];
    for (const [x, y] of [[0.25, 0.25], [0.75, 0.5], [0.5, 0.8]] as const) {
      const to = driver.toGlobal({ screen: screen.name, x, y });
      await driver.moveToGlobal(to, { dur: 0.3 });
      await sleep(150);
      const seen = driver.cursor();
      const dist = Math.hypot(seen.x - to.x, seen.y - to.y);
      out.push(`(${Math.round(to.x)},${Math.round(to.y)}) off by ${dist.toFixed(1)}`);
      if (dist > 1.5) throw new Error(`pointer is ${dist.toFixed(1)} px off target: ${out.join("; ")}`);
    }
    return out.join("; ");
  });

  await check("target app: launch + find window (EWMH)", async () => {
    if (!driver) throw new Error("needs driver");
    target = startTarget(work);
    win = await waitWindow(driver, "smoketarget");
    return `window ${win.id} class ${win.resourceClass} pid ${win.pid} "${win.caption}" ${rectText(win)}`;
  });

  await check("focus on monitor at 16:9", async () => {
    if (!driver || !win || !screen) throw new Error("needs the target window");
    await driver.desktop.focusWindow(win.id, { screen: screen.name });
    await sleep(400);
    win = await refresh(driver, win.id);
    const aspect = win.w / win.h;
    const inside = win.x >= screen.x - 2 && win.y >= screen.y - 2 && win.x + win.w <= screen.x + screen.w + 2 && win.y + win.h <= screen.y + screen.h + 2;
    if (!inside) throw new Error(`window ${rectText(win)} is outside monitor ${rectText(screen)}`);
    if (Math.abs(aspect - 16 / 9) > 0.06) throw new Error(`aspect ${aspect.toFixed(3)} is not 16:9 (${rectText(win)})`);
    if (!win.active) throw new Error("window is not active after focusWindow");
    return `${rectText(win)} aspect ${aspect.toFixed(3)}, active`;
  });
  await shot("02-target-focused");

  await check("fitWindow + restore round trip", async () => {
    if (!driver || !win) throw new Error("needs the target window");
    await driver.desktop.focusWindow(win.id, { x: (screen?.x ?? 0) + 80, y: (screen?.y ?? 0) + 70, w: 600, h: 420 });
    await sleep(300);
    const before = await refresh(driver, win.id);
    const fit = await driver.desktop.fitWindow("smoketarget", 16 / 9);
    await sleep(300);
    const fitted = await refresh(driver, win.id);
    if (Math.abs(fitted.w / fitted.h - 16 / 9) > 0.06) throw new Error(`fitted ${rectText(fitted)} is not 16:9`);
    await fit.restore();
    await sleep(400);
    const after = await refresh(driver, win.id);
    const off = (["x", "y", "w", "h"] as const).map((k) => Math.abs(after[k] - before[k]));
    if (off.some((o) => o > 4)) throw new Error(`restore off by ${off.join("/")} px: before ${rectText(before)}, after ${rectText(after)}`);
    win = after;
    return `fitted ${rectText(fitted)}, restored ${rectText(after)}`;
  });

  await check(`type ${JSON.stringify(TYPED)} (XTest + spare keycode remap)`, async () => {
    if (!driver || !win || !target) throw new Error("needs the target window");
    const w = await refresh(driver, win.id);
    await driver.desktop.focusWindow(w.id);
    await driver.moveToGlobal({ x: w.x + w.w / 2, y: w.y + w.h / 2 }, { dur: 0.3 });
    await driver.click();
    await sleep(300);
    await driver.type(TYPED, { cps: 25 });
    await sleep(500);
    const got = readTyped(target.out);
    if (got !== TYPED) throw new Error(`target has ${JSON.stringify(got)}, expected ${JSON.stringify(TYPED)}`);
    await driver.key("backspace");
    await sleep(400);
    const after = readTyped(target.out);
    if (after !== TYPED.slice(0, -1)) throw new Error(`after backspace: ${JSON.stringify(after)}`);
    return `read back ${JSON.stringify(got)}; backspace → ${JSON.stringify(after)}`;
  });
  await shot("03-typed");

  await check("demo browser: trusted clicks (web targets)", async () => {
    if (!driver || !screen) throw new Error("needs driver + screen");
    // Locally, a demo browser already running on the real desktop would be reused: opt out.
    if (process.env.X11_SMOKE_NO_BROWSER) return "skipped (X11_SMOKE_NO_BROWSER)";
    try {
      findBrowser();
    } catch {
      return "skipped: no Chromium-based browser installed";
    }
    await openBrowser({ screen, url: writeSmokePage(), log });
    await sleep(500);
    for (const sel of ["#a", "#b"]) {
      const r = await locate(sel, driver);
      await driver.moveToGlobal({ x: r.x, y: r.y }, { dur: 0.3 });
      await sleep(150);
      await driver.click();
      await sleep(250);
    }
    await shot("04-browser");
    const clicks = (await withPage((p) => p.evaluate("window.__clicks"))) as { id: string; trusted: boolean }[];
    if (clicks.length !== 2 || !clicks.every((c) => c.trusted)) throw new Error(`expected 2 trusted clicks, got ${JSON.stringify(clicks)}`);
    return `clicks: ${clicks.map((c) => `${c.id} trusted=${c.trusted}`).join(", ")}`;
  });

  await check("driver close", async () => {
    await driver?.close();
    return "closed (spare keycodes unbound)";
  });

  await check("native screenshot (x11grab)", async () => {
    const r = await screenshot(await (await getDesktop()).screens(), { outDir: join(OUT, "screens"), width: 640 });
    if (r.shots.length === 0) throw new Error("no shots");
    return r.shots.map((x) => `${x.screen} → ${x.file}`).join("; ");
  });

  await check("native recording 3 s (x11grab), playable", async () => {
    const rec = await startRecording({ dir: join(OUT, "recording"), screens: "all", recorder: "native", log });
    // Some pointer motion so the pointer log has something in it.
    const d = await Driver.open({ log });
    await d.moveTo({ x: 0.3, y: 0.3 }, { dur: 0.5 });
    await d.moveTo({ x: 0.6, y: 0.6 }, { dur: 0.5 });
    await d.close();
    await sleep(2000);
    const r = await rec.stop();
    if (!(r.duration > 1.5)) throw new Error(`recording too short: ${r.duration}s (${r.video})`);
    await playable(r.video);
    return `${r.video} ${r.duration.toFixed(2)}s, input ${r.inputAdapter}, events ${r.eventCount}, warnings ${r.warnings.length}`;
  });

  await check("perform: recorded take → storyboard", async () => {
    const take = join(work, "take.json");
    writeFileSync(
      take,
      JSON.stringify({
        screens: "all",
        steps: [
          { focus: { match: "smoketarget" } },
          { click: { window: "smoketarget", x: 0.5, y: 0.5 } },
          { type: " ok" },
          { wait: 0.4 },
          { click: { window: "smoketarget", x: 0.3, y: 0.6 } },
          { wait: 0.5 },
        ],
      }),
    );
    const r = await performTake(take, { dir: join(OUT, "take"), log });
    const sb = JSON.parse(readFileSync(r.storyboard!, "utf8")) as { views?: unknown[]; zooms?: unknown[] };
    if (!r.recording || r.recording.duration < 1) throw new Error("no recording");
    await playable(r.recording.video);
    if (!sb.zooms?.length) throw new Error("storyboard has no zooms from the clicks");
    const windows = existsSync(join(r.dir!, "windows.jsonl"));
    return `${r.recording.video} ${r.recording.duration.toFixed(1)}s; zooms ${sb.zooms.length}, views ${sb.views?.length ?? 0}, windows.jsonl ${windows}`;
  });
  await shot("05-end");

  target?.child.kill();
}

try {
  await main();
} catch (err) {
  results.push({ name: "smoke script", ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err), ms: 0 });
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: failed.length === 0, display: process.env.DISPLAY, checks: results }, null, 2)}\n`);
log(`${results.length - failed.length}/${results.length} checks passed; report in ${OUT}`);
process.exit(failed.length ? 1 : 0);
