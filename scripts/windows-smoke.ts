// End-to-end check for a real Windows desktop (GitHub runner or your PC):
//   pnpm smoke:windows
// Drives the real pointer and keyboard, so keep your hands off. Writes
// smoke-report/report.json and screenshots; exits 1 if any check failed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Driver } from "../src/drive/index.js";
import { screenshot } from "../src/drive/see.js";
import { locate, openBrowser, withPage } from "../src/drive/web.js";
import { startRecording } from "../src/record/index.js";
import { performTake } from "../src/take/perform.js";
import { getDesktop, type WindowInfo } from "../src/platform/index.js";
import type { ScreenInfo } from "../src/record/input/types.js";
import { run } from "../src/util/exec.js";

const OUT = resolve("smoke-report");
const TYPED = "Hello 123 مرحبا 😀\n";
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

const ps = (script: string) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** Whole virtual screen (all monitors, physical pixels) to a PNG. No OBS needed. */
async function shot(name: string): Promise<void> {
  const file = join(OUT, `${name}.png`).replace(/'/g, "''");
  try {
    await ps(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[W.U]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`);
  } catch (err) {
    log(`screenshot ${name} failed: ${(err as Error).message}`);
  }
}

const near = (a: number, b: number, px: number) => Math.abs(a - b) <= px;
const rectText = (w: { x: number; y: number; w: number; h: number }) => `${w.x},${w.y} ${w.w}x${w.h}`;

async function waitWindow(d: Driver, exe: string, timeoutMs = 15_000): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await d.desktop.listWindows()).find((w) => w.resourceClass.toLowerCase() === exe);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no ${exe} window appeared`);
    await sleep(300);
  }
}

const refresh = async (d: Driver, id: string) => {
  const w = (await d.desktop.listWindows()).find((x) => x.id === id);
  if (!w) throw new Error(`window ${id} is gone`);
  return w;
};

// Test page: buttons record whether the click was a real (trusted) input event.
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
  let driver: Driver | undefined;
  let screen: ScreenInfo | undefined;
  let notepadPid: number | undefined;
  let notepad: WindowInfo | undefined;

  await check("desktop is windows", async () => {
    const id = (await getDesktop()).id;
    if (id !== "windows") throw new Error(`desktop id is "${id}"`);
    return id;
  });

  await check("screens", async () => {
    const screens = await (await getDesktop()).screens();
    if (screens.length === 0) throw new Error("no monitors");
    for (const s of screens) if (!(s.w > 0 && s.h > 0 && s.w < 20_000 && s.h < 20_000)) throw new Error(`odd monitor rect ${s.name}: ${rectText(s)}`);
    screen = screens[0];
    return screens.map((s) => `${s.name} ${rectText(s)}`).join("; ");
  });
  await shot("01-desktop");

  await check("driver open", async () => {
    driver = await Driver.open({ log });
    return `${driver.screens().length} monitor(s)`;
  });

  await check("pointer reaches targets", async () => {
    if (!driver || !screen) throw new Error("needs driver + screen");
    const out: string[] = [];
    for (const [x, y] of [[0.25, 0.25], [0.75, 0.5], [0.5, 0.8]] as const) {
      const to = driver.toGlobal({ screen: screen.name, x, y });
      await driver.moveToGlobal(to, { dur: 0.3 });
      await sleep(200);
      const seen = driver.cursor();
      const dist = Math.hypot(seen.x - to.x, seen.y - to.y);
      out.push(`(${Math.round(to.x)},${Math.round(to.y)}) off by ${dist.toFixed(1)}`);
      if (dist > 3) throw new Error(`pointer is ${dist.toFixed(1)} px off target: ${out.join("; ")}`);
    }
    return out.join("; ");
  });

  await check("notepad: launch + find window", async () => {
    const child = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
    child.unref();
    notepadPid = child.pid;
    if (!driver) throw new Error("needs driver");
    notepad = await waitWindow(driver, "notepad.exe");
    return `window ${notepad.id} pid ${notepad.pid} "${notepad.caption}"`;
  });

  await check("notepad: focus on monitor at 16:9", async () => {
    if (!driver || !notepad || !screen) throw new Error("needs notepad window");
    await driver.desktop.focusWindow(notepad.id, { screen: screen.name });
    await sleep(600);
    notepad = await refresh(driver, notepad.id);
    const aspect = notepad.w / notepad.h;
    const inside = notepad.x >= screen.x - 2 && notepad.y >= screen.y - 2 && notepad.x + notepad.w <= screen.x + screen.w + 2 && notepad.y + notepad.h <= screen.y + screen.h + 2;
    if (!inside) throw new Error(`window ${rectText(notepad)} is outside monitor ${rectText(screen)}`);
    if (Math.abs(aspect - 16 / 9) > 0.06) throw new Error(`aspect ${aspect.toFixed(3)} is not 16:9 (${rectText(notepad)})`);
    return `${rectText(notepad)} aspect ${aspect.toFixed(3)}`;
  });
  await shot("02-notepad-focused");

  await check("notepad: fitWindow + restore round trip", async () => {
    if (!driver || !notepad) throw new Error("needs notepad window");
    const before = await refresh(driver, notepad.id);
    const fit = await driver.desktop.fitWindow("notepad", 16 / 9);
    await sleep(400);
    const fitted = await refresh(driver, notepad.id);
    await fit.restore();
    await sleep(600);
    const after = await refresh(driver, notepad.id);
    const keys = ["x", "y", "w", "h"] as const;
    const off = keys.map((k) => Math.abs(after[k] - before[k]));
    if (off.some((o) => o > 4)) throw new Error(`restore off by ${off.join("/")} px: before ${rectText(before)}, after ${rectText(after)}`);
    notepad = after;
    return `fitted ${rectText(fitted)}, restored ${rectText(after)} (was ${rectText(before)})`;
  });

  await check("notepad: type + clipboard round trip", async () => {
    if (!driver || !notepad) throw new Error("needs notepad window");
    const w = await refresh(driver, notepad.id);
    await driver.desktop.focusWindow(w.id);
    await driver.moveToGlobal({ x: w.x + w.w / 2, y: w.y + w.h / 2 }, { dur: 0.3 });
    await driver.click();
    await sleep(300);
    await driver.type(TYPED, { cps: 30 });
    await sleep(300);
    await shot("03-notepad-typed");
    await ps("Set-Clipboard -Value 'smoke-sentinel'"); // so a failed copy cannot pass
    await driver.key("ctrl+a");
    await sleep(150);
    await driver.key("ctrl+c");
    await sleep(500);
    const { stdout } = await ps("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw");
    const got = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const want = TYPED.replace(/\n$/, "");
    // Notepad may or may not keep the trailing newline; compare without it.
    if (got.replace(/\n$/, "") !== want) throw new Error(`clipboard ${JSON.stringify(got)} != typed ${JSON.stringify(want)}`);
    return `clipboard matches ${JSON.stringify(want)}`;
  });

  // Close Notepad without saving: kill what we started and the window's own process (Win11 Notepad re-launches itself).
  await check("notepad: close without saving", async () => {
    const pids = new Set([notepadPid, notepad?.pid].filter((p): p is number => !!p));
    for (const pid of pids) await run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
    await sleep(500);
    const left = driver ? (await driver.desktop.listWindows()).filter((w) => notepad && w.id === notepad.id) : [];
    if (left.length) throw new Error("notepad window is still open");
    return `killed pid ${[...pids].join(",")}`;
  });

  await check("demo browser: trusted clicks", async () => {
    if (!driver || !screen) throw new Error("needs driver + screen");
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
    return "closed";
  });

  await check("native screenshot (gdigrab)", async () => {
    const r = await screenshot(await (await getDesktop()).screens(), { outDir: join(OUT, "screens"), width: 960 });
    if (r.shots.length === 0) throw new Error("no shots");
    return r.shots.map((x) => `${x.screen} → ${x.file}`).join("; ");
  });

  await check("native recording 3 s (gdigrab)", async () => {
    const rec = await startRecording({ dir: join(OUT, "recording"), screens: "all", recorder: "native", log });
    await sleep(3000);
    const r = await rec.stop();
    if (!(r.duration > 1.5)) throw new Error(`recording too short: ${r.duration}s (${r.video})`);
    return `${r.video} ${r.duration.toFixed(2)}s, events ${r.eventCount}, warnings ${r.warnings.length}`;
  });
  await check("perform: recorded take → storyboard", async () => {
    const takeDir = mkdtempSync(join(tmpdir(), "smoke-take-"));
    const take = join(takeDir, "take.json");
    writeFileSync(
      take,
      JSON.stringify({
        screens: "all",
        setup: [{ browser: { url: writeSmokePage() } }],
        steps: [{ click: { web: "#a" } }, { wait: 0.5 }, { click: { web: "#b" } }, { key: "ctrl+a" }, { wait: 0.5 }],
      }),
    );
    const r = await performTake(take, { dir: join(OUT, "take"), log });
    const sb = JSON.parse(readFileSync(r.storyboard!, "utf8")) as { views?: unknown[]; zooms?: unknown[] };
    if (!r.recording || r.recording.duration < 1) throw new Error("no recording");
    if (!sb.zooms?.length) throw new Error("storyboard has no zooms from the clicks");
    return `${r.recording.video} ${r.recording.duration.toFixed(1)}s; zooms ${sb.zooms.length}, views ${sb.views?.length ?? 0}`;
  });
  await shot("05-end");
}

try {
  await main();
} catch (err) {
  results.push({ name: "smoke script", ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err), ms: 0 });
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: failed.length === 0, platform: process.platform, checks: results }, null, 2)}\n`);
log(`${results.length - failed.length}/${results.length} checks passed; report in ${OUT}`);
process.exit(failed.length ? 1 : 0);
