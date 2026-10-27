// Multi-monitor / mixed-DPI check for a real Windows desktop with TWO monitors:
//   pnpm smoke:windows-multimon
// CI builds that desktop with scripts/ci/windows-multimon-setup.ps1: the primary
// monitor at 0,0 and a virtual second one to its right, shifted up, at another
// DPI scale. Layout expectations come from the environment (defaults match CI):
//   MM_X2, MM_Y2, MM_W2, MM_H2  rect of the second monitor (default 1024,-200 1920x1080)
//   MM_SCALE2                   its DPI scale in percent (default 150)
// Drives the real pointer, so keep your hands off. Writes multimon-report/.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDesktop, type WindowInfo } from "../src/platform/index.js";
import { win32, type Monitor } from "../src/platform/windows/win32.js";
import { readEvents, clicksOf } from "../src/record/events.js";
import { startRecording } from "../src/record/index.js";
import type { Rect } from "../src/record/input/types.js";
import { Driver } from "../src/drive/index.js";
import { screenshot } from "../src/drive/see.js";
import { run } from "../src/util/exec.js";
import { probeVideo } from "../src/util/media.js";

const OUT = resolve("multimon-report");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stderr.write(`multimon: ${m}\n`);
const num = (name: string, dflt: number) => (process.env[name] !== undefined ? Number(process.env[name]) : dflt);

const WANT2: Rect = { x: num("MM_X2", 1024), y: num("MM_Y2", -200), w: num("MM_W2", 1920), h: num("MM_H2", 1080) };
const SCALE2 = num("MM_SCALE2", 150);

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

const rectText = (r: Rect) => `${r.x},${r.y} ${r.w}x${r.h}`;
const sameRect = (a: Rect, b: Rect, tol = 0) => (["x", "y", "w", "h"] as const).every((k) => Math.abs(a[k] - b[k]) <= tol);
const inside = (r: Rect, area: Rect, tol = 2) =>
  r.x >= area.x - tol && r.y >= area.y - tol && r.x + r.w <= area.x + area.w + tol && r.y + r.h <= area.y + area.h + tol;
const ps = (script: string) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** Monitors as an independent PowerShell process (per-monitor DPI aware) sees them: the oracle for our own reading. */
async function psMonitors(): Promise<{ name: string; primary: boolean; bounds: Rect; work: Rect }[]> {
  const { stdout } = await ps(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'
[W.U]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$all = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ name = $_.DeviceName; primary = $_.Primary
    bounds = @{ x = $_.Bounds.X; y = $_.Bounds.Y; w = $_.Bounds.Width; h = $_.Bounds.Height }
    work = @{ x = $_.WorkingArea.X; y = $_.WorkingArea.Y; w = $_.WorkingArea.Width; h = $_.WorkingArea.Height } }
})
ConvertTo-Json -Compress -InputObject $all`);
  return JSON.parse(stdout);
}

/** The whole virtual screen (physical px) to a PNG, from an independent process. */
async function shot(name: string): Promise<void> {
  const file = join(OUT, `${name}.png`).replace(/'/g, "''");
  try {
    await ps(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'
[W.U]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
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

// A borderless solid-colour window, so recordings can be checked pixel by pixel.
const MARKER_PS = `
param([string]$Title, [string]$Color)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'
[W.U]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$f = New-Object System.Windows.Forms.Form
$f.Text = $Title
$f.FormBorderStyle = 'None'
$f.AutoScaleMode = 'None'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(0, 0)
$f.Size = New-Object System.Drawing.Size(200, 120)
$f.BackColor = [System.Drawing.ColorTranslator]::FromHtml($Color)
$f.TopMost = $true
[System.Windows.Forms.Application]::Run($f)
`;

const px = (r: Rect, dx: number, dy: number, w: number, h: number): Rect => ({ x: r.x + dx, y: r.y + dy, w, h });

async function waitTitle(desktop: Awaited<ReturnType<typeof getDesktop>>, title: string, timeoutMs = 20_000): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await desktop.listWindows()).find((w) => w.caption === title);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no window titled ${title} appeared`);
    await sleep(300);
  }
}

/** First frame at `at` seconds as raw RGB. */
async function frameRgb(video: string, at: number, width: number, height: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.once("error", rej);
    p.once("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
  });
  const buf = Buffer.concat(chunks);
  if (buf.length !== width * height * 3) throw new Error(`frame is ${buf.length} bytes, expected ${width * height * 3} for ${width}x${height}`);
  return buf;
}

/** Bounding box of pixels close to `rgb` (compression blurs colours a little), with their count. */
function colorBox(buf: Buffer, width: number, height: number, rgb: [number, number, number], tol = 40): (Rect & { count: number }) | undefined {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (Math.abs(buf[i]! - rgb[0]) <= tol && Math.abs(buf[i + 1]! - rgb[1]) <= tol && Math.abs(buf[i + 2]! - rgb[2]) <= tol) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return count ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count } : undefined;
}

const MAGENTA: [number, number, number] = [255, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const desktop = await getDesktop();
  const w = await win32();
  let mons: Monitor[] = [];
  let m1!: Monitor;
  let m2!: Monitor;
  const procs: ChildProcess[] = [];
  let notepadPid: number | undefined;

  await check("desktop is windows", async () => {
    if (desktop.id !== "windows") throw new Error(`desktop id is "${desktop.id}"`);
    return desktop.id;
  });

  await check("screens: 2 monitors, physical px, work areas, DPI", async () => {
    const screens = await desktop.screens();
    mons = w.monitors();
    if (screens.length !== 2 || mons.length !== 2) throw new Error(`expected 2 monitors, got ${screens.length}: ${screens.map((s) => `${s.name} ${rectText(s)}`).join("; ")}`);
    m1 = mons.find((m) => m.primary)!;
    m2 = mons.find((m) => !m.primary)!;
    if (!m1 || !m2) throw new Error("need one primary and one secondary monitor");
    if (!sameRect(m2.screen, WANT2)) throw new Error(`second monitor is ${rectText(m2.screen)}, expected ${rectText(WANT2)}`);
    if (!(m1.screen.x === 0 && m1.screen.y === 0)) throw new Error(`primary is not at 0,0: ${rectText(m1.screen)}`);
    for (const m of mons) if (!inside(m.work, m.screen, 0)) throw new Error(`work area ${rectText(m.work)} not inside ${rectText(m.screen)}`);
    // Independent oracle: another process asks Windows for the same layout.
    const oracle = await psMonitors();
    for (const m of mons) {
      const o = oracle.find((x) => x.name === m.screen.name);
      if (!o) throw new Error(`oracle has no ${m.screen.name} (has ${oracle.map((x) => x.name).join(", ")})`);
      if (!sameRect(o.bounds, m.screen)) throw new Error(`${m.screen.name}: we say ${rectText(m.screen)}, Windows says ${rectText(o.bounds)}`);
      if (!sameRect(o.work, m.work)) throw new Error(`${m.screen.name}: work area we say ${rectText(m.work)}, Windows says ${rectText(o.work)}`);
    }
    const wantDpi2 = Math.round((96 * SCALE2) / 100);
    if (m2.dpi !== wantDpi2) throw new Error(`second monitor DPI is ${m2.dpi}, expected ${wantDpi2} (${SCALE2}%)`);
    if (m1.dpi === m2.dpi) throw new Error(`both monitors have DPI ${m1.dpi}: not mixed DPI`);
    return mons.map((m) => `${m.screen.name}${m.primary ? "*" : ""} ${rectText(m.screen)} work ${rectText(m.work)} dpi ${m.dpi}`).join("; ");
  });
  await shot("01-desktop");

  await check("SendInput reaches points on both monitors (±1 px)", async () => {
    const inj = await desktop.openInjector((await desktop.screens()), log);
    const pts: [string, number, number][] = [];
    for (const m of [m1, m2]) {
      const s = m.screen;
      pts.push(
        [`${s.name} top-left`, s.x, s.y],
        [`${s.name} bottom-right`, s.x + s.w - 1, s.y + s.h - 1],
        [`${s.name} 1/3,2/3`, s.x + Math.round(s.w / 3), s.y + Math.round((2 * s.h) / 3)],
        [`${s.name} 7/8,1/8`, s.x + Math.round((7 * s.w) / 8), s.y + Math.round(s.h / 8)],
      );
    }
    const bad: string[] = [];
    const ok: string[] = [];
    try {
      for (const [label, x, y] of pts) {
        const moved = await inj.moveTo(x, y);
        await sleep(80);
        const c = w.cursorPos();
        const d = c ? Math.max(Math.abs(c.x - x), Math.abs(c.y - y)) : Infinity;
        (moved && d <= 1 ? ok : bad).push(`${label} want ${x},${y} got ${c ? `${c.x},${c.y}` : "?"}${moved ? "" : " (refused)"}`);
      }
    } finally {
      await inj.close();
    }
    if (bad.length) throw new Error(`${bad.length}/${pts.length} off: ${bad.join("; ")}`);
    return `${ok.length} points exact within 1 px: ${ok.slice(-3).join("; ")}`;
  });

  await check("Driver targets {screen, x, y} on both monitors", async () => {
    const driver = await Driver.open({ log });
    try {
      const out: string[] = [];
      for (const m of [m2, m1]) {
        for (const [x, y] of [[0.5, 0.5], [0.9, 0.1]] as const) {
          const to = driver.toGlobal({ screen: m.screen.name, x, y });
          await driver.moveToGlobal(to, { dur: 0.3 });
          await sleep(150);
          const c = w.cursorPos()!;
          const d = Math.max(Math.abs(c.x - to.x), Math.abs(c.y - to.y));
          if (d > 1) throw new Error(`${m.screen.name} (${x},${y}): wanted ${Math.round(to.x)},${Math.round(to.y)}, pointer is at ${c.x},${c.y}`);
          out.push(`${m.screen.name} (${x},${y}) -> ${c.x},${c.y}`);
        }
      }
      return out.join("; ");
    } finally {
      await driver.close();
    }
  });

  let notepad: WindowInfo | undefined;
  await check("notepad: focus on monitor 2 at 16:9 inside its work area", async () => {
    const child = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
    child.unref();
    notepadPid = child.pid;
    const deadline = Date.now() + 15_000;
    for (;;) {
      notepad = (await desktop.listWindows()).find((x) => x.resourceClass === "notepad.exe");
      if (notepad) break;
      if (Date.now() > deadline) throw new Error("no notepad window appeared");
      await sleep(300);
    }
    await desktop.focusWindow(notepad.id, { screen: m2.screen.name });
    await sleep(800);
    notepad = (await desktop.listWindows()).find((x) => x.id === notepad!.id)!;
    const aspect = notepad.w / notepad.h;
    if (!inside(notepad, m2.work)) throw new Error(`notepad ${rectText(notepad)} is outside monitor 2's work area ${rectText(m2.work)}`);
    if (notepad.output !== m2.screen.name) throw new Error(`notepad is reported on ${notepad.output}, not ${m2.screen.name}`);
    if (Math.abs(aspect - 16 / 9) > 0.06) throw new Error(`aspect ${aspect.toFixed(3)} is not 16:9 (${rectText(notepad)})`);
    return `${rectText(notepad)} aspect ${aspect.toFixed(3)} on ${notepad.output}`;
  });

  await check("notepad: fitWindow on monitor 2 + restore", async () => {
    if (!notepad) throw new Error("needs notepad");
    const before = notepad;
    const fit = await desktop.fitWindow("notepad", 16 / 9);
    await sleep(500);
    const fitted = (await desktop.listWindows()).find((x) => x.id === before.id)!;
    await fit.restore();
    await sleep(600);
    const after = (await desktop.listWindows()).find((x) => x.id === before.id)!;
    if (!inside(fitted, m2.work)) throw new Error(`fitted ${rectText(fitted)} is outside ${rectText(m2.work)}`);
    if (Math.abs(fitted.w / fitted.h - 16 / 9) > 0.06) throw new Error(`fitted aspect ${(fitted.w / fitted.h).toFixed(3)} (${rectText(fitted)})`);
    if (!sameRect(after, before, 4)) throw new Error(`restore off: before ${rectText(before)}, after ${rectText(after)}`);
    return `fitted ${rectText(fitted)}, restored ${rectText(after)}`;
  });
  await shot("02-notepad-on-monitor-2");
  if (notepadPid) await run("taskkill", ["/PID", String(notepadPid), "/T", "/F"]).catch(() => {});
  if (notepad) await run("taskkill", ["/PID", String(notepad.pid), "/T", "/F"]).catch(() => {});

  // Markers at known spots: magenta on monitor 2, green on the primary.
  const dir = mkdtempSync(join(tmpdir(), "mm-marker-"));
  const markerPs = join(dir, "marker.ps1");
  writeFileSync(markerPs, MARKER_PS);
  const rel2 = { dx: 100, dy: 50, w: 320, h: 180 };
  const rel1 = { dx: 60, dy: 40, w: 200, h: 120 };
  let marker1: Rect | undefined;
  let marker2: Rect | undefined;
  await check("marker windows land exactly where placed (both DPIs)", async () => {
    for (const [title, color] of [["mm-marker-1", "#00FF00"], ["mm-marker-2", "#FF00FF"]] as const) {
      const p = spawn("powershell", ["-NoProfile", "-STA", "-File", markerPs, "-Title", title, "-Color", color], { stdio: "ignore", windowsHide: true });
      procs.push(p);
    }
    const out: string[] = [];
    for (const [title, mon, rel] of [["mm-marker-1", m1, rel1], ["mm-marker-2", m2, rel2]] as const) {
      const win = await waitTitle(desktop, title);
      const target = px(mon.screen, rel.dx, rel.dy, rel.w, rel.h);
      let got: WindowInfo = win;
      for (let i = 0; i < 4; i++) {
        await desktop.focusWindow(win.id, { x: target.x, y: target.y, w: target.w, h: target.h });
        await sleep(400);
        got = (await desktop.listWindows()).find((x) => x.id === win.id)!;
        if (sameRect(got, target, 1)) break;
      }
      if (!sameRect(got, target, 1)) throw new Error(`${title}: wanted ${rectText(target)}, window is ${rectText(got)}`);
      if (title === "mm-marker-1") marker1 = target;
      else marker2 = target;
      out.push(`${title} ${rectText(got)}`);
    }
    return out.join("; ");
  });
  await shot("03-markers");

  // A recording while the pointer clicks on both monitors; returns the video, its size and click events.
  const clicksFor = (m: Monitor): [number, number][] => [
    [m.screen.x + Math.round(m.screen.w * 0.5), m.screen.y + Math.round(m.screen.h * 0.6)],
    [m.screen.x + Math.round(m.screen.w * 0.8), m.screen.y + Math.round(m.screen.h * 0.3)],
    [m.screen.x + Math.round(m.screen.w * 0.25), m.screen.y + Math.round(m.screen.h * 0.8)],
  ];
  async function recordClicks(name: string, opts: { screens?: "all"; screen?: string }, targets: [number, number][]) {
    const rec = await startRecording({ dir: join(OUT, name), recorder: "native", log, ...opts });
    const inj = await desktop.openInjector(await desktop.screens(), log);
    try {
      await sleep(1200);
      for (const [x, y] of targets) {
        await inj.moveTo(x, y);
        await sleep(250);
        await inj.button("left", true);
        await sleep(60);
        await inj.button("left", false);
        await sleep(400);
      }
      await sleep(800);
    } finally {
      await inj.close();
    }
    const r = await rec.stop();
    return { r, info: await probeVideo(r.video) };
  }
  const dumpFrame = async (video: string, file: string) => {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", video, "-frames:v", "1", "-y", join(OUT, file)]).catch(() => {});
  };

  await check("record --screens all: union canvas, markers and clicks line up", async () => {
    if (!marker1 || !marker2) throw new Error("needs the marker windows");
    const screens = await desktop.screens();
    const u = {
      x: Math.min(...screens.map((s) => s.x)),
      y: Math.min(...screens.map((s) => s.y)),
      w: Math.max(...screens.map((s) => s.x + s.w)) - Math.min(...screens.map((s) => s.x)),
      h: Math.max(...screens.map((s) => s.y + s.h)) - Math.min(...screens.map((s) => s.y)),
    };
    const wantW = u.w - (u.w % 2);
    const wantH = u.h - (u.h % 2);
    const targets = [...clicksFor(m1).slice(0, 2), ...clicksFor(m2).slice(0, 2)];
    const { r, info } = await recordClicks("rec-all", { screens: "all" }, targets);
    await dumpFrame(r.video, "rec-all-frame.png");
    if (info.width !== wantW || info.height !== wantH) throw new Error(`video is ${info.width}x${info.height}, union canvas is ${wantW}x${wantH} (${rectText(u)})`);
    const frame = await frameRgb(r.video, 1, info.width, info.height);
    const found: string[] = [];
    for (const [label, rgb, want] of [["green/primary", GREEN, marker1], ["magenta/monitor2", MAGENTA, marker2]] as const) {
      const box = colorBox(frame, info.width, info.height, rgb);
      const exp = { x: want.x - u.x, y: want.y - u.y, w: want.w, h: want.h };
      if (!box) throw new Error(`${label} marker is not in the video`);
      if (!sameRect(box, exp, 2)) throw new Error(`${label} marker at ${rectText(box)} in the video, expected ${rectText(exp)} (union ${rectText(u)})`);
      found.push(`${label} ${rectText(box)}`);
    }
    const clicks = clicksOf(await readEvents(r.events!));
    if (clicks.length !== targets.length) throw new Error(`${clicks.length} clicks logged, expected ${targets.length}`);
    const errs = targets.map(([x, y], i) => Math.max(Math.abs(clicks[i]!.x - (x - u.x) / u.w) * u.w, Math.abs(clicks[i]!.y - (y - u.y) / u.h) * u.h));
    if (errs.some((e) => e > 2.5)) throw new Error(`click positions off by ${errs.map((e) => e.toFixed(1)).join("/")} px of the union canvas`);
    return `video ${info.width}x${info.height} (union ${rectText(u)}); ${found.join("; ")}; ${clicks.length} clicks within ${Math.max(...errs).toFixed(1)} px`;
  });

  await check("record --screen <monitor 2>: only that monitor, offset and clicks correct", async () => {
    if (!marker1 || !marker2) throw new Error("needs the marker windows");
    const s2 = m2.screen;
    const wantW = s2.w - (s2.w % 2);
    const wantH = s2.h - (s2.h % 2);
    // Two clicks on monitor 2, one on the primary (must not be logged: it is off the recorded screen).
    const t2 = clicksFor(m2).slice(0, 2);
    const onPrimary = clicksFor(m1)[0]!;
    const { r, info } = await recordClicks("rec-mon2", { screen: s2.name }, [t2[0]!, onPrimary, t2[1]!]);
    await dumpFrame(r.video, "rec-mon2-frame.png");
    if (info.width !== wantW || info.height !== wantH) throw new Error(`video is ${info.width}x${info.height}, monitor 2 is ${wantW}x${wantH}`);
    const frame = await frameRgb(r.video, 1, info.width, info.height);
    const box = colorBox(frame, info.width, info.height, MAGENTA);
    const exp = { x: marker2.x - s2.x, y: marker2.y - s2.y, w: marker2.w, h: marker2.h };
    if (!box) throw new Error("monitor 2's marker is not in the video");
    if (!sameRect(box, exp, 2)) throw new Error(`marker at ${rectText(box)} in the video, expected ${rectText(exp)}`);
    if (colorBox(frame, info.width, info.height, GREEN, 40)) throw new Error("the primary monitor's marker is in monitor 2's video");
    const clicks = clicksOf(await readEvents(r.events!));
    if (clicks.length !== 2) throw new Error(`${clicks.length} clicks logged, expected 2 (the primary-monitor click must be dropped): ${JSON.stringify(clicks)}`);
    const errs = t2.map(([x, y], i) => Math.max(Math.abs(clicks[i]!.x - (x - s2.x) / s2.w) * s2.w, Math.abs(clicks[i]!.y - (y - s2.y) / s2.h) * s2.h));
    if (errs.some((e) => e > 2.5)) throw new Error(`click positions off by ${errs.map((e) => e.toFixed(1)).join("/")} px of monitor 2`);
    return `video ${info.width}x${info.height}; marker ${rectText(box)}; ${clicks.length} clicks within ${Math.max(...errs).toFixed(1)} px, primary click dropped`;
  });

  await check("record --screen <primary>: only the primary", async () => {
    if (!marker1) throw new Error("needs the marker windows");
    const s1 = m1.screen;
    const { r, info } = await recordClicks("rec-mon1", { screen: s1.name }, [clicksFor(m1)[0]!]);
    if (info.width !== s1.w - (s1.w % 2) || info.height !== s1.h - (s1.h % 2)) throw new Error(`video is ${info.width}x${info.height}, primary is ${s1.w}x${s1.h}`);
    const frame = await frameRgb(r.video, 1, info.width, info.height);
    const box = colorBox(frame, info.width, info.height, GREEN);
    const exp = { x: marker1.x - s1.x, y: marker1.y - s1.y, w: marker1.w, h: marker1.h };
    if (!box || !sameRect(box, exp, 2)) throw new Error(`marker at ${box ? rectText(box) : "nowhere"}, expected ${rectText(exp)}`);
    if (colorBox(frame, info.width, info.height, MAGENTA)) throw new Error("monitor 2's marker is in the primary's video");
    return `video ${info.width}x${info.height}; marker ${rectText(box)}`;
  });

  await check("native screenshot of each monitor", async () => {
    const r = await screenshot(await desktop.screens(), { outDir: join(OUT, "screens"), width: 960 });
    if (r.shots.length !== 2) throw new Error(`${r.shots.length} shots, expected 2`);
    return r.shots.map((x) => `${x.screen} → ${x.file}`).join("; ");
  });
  await shot("04-end");

  for (const p of procs) p.kill();
}

try {
  await main();
} catch (err) {
  results.push({ name: "smoke script", ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err), ms: 0 });
}
const failed = results.filter((r) => !r.ok);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: failed.length === 0, platform: process.platform, checks: results }, null, 2)}\n`);
log(`${results.length - failed.length}/${results.length} checks passed; report in ${OUT}`);
process.exit(failed.length ? 1 : 0);
