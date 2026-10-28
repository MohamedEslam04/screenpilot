import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP } from "./brand.js";
import { DESKTOP_ENV } from "./brand.js";
import { Driver } from "./drive/index.js";
import { portalVersion } from "./drive/portal.js";
import { findBrowser } from "./drive/web.js";
import { DESKTOP_IDS, desktopName, isWlrootsEnv } from "./platform/detect.js";
import { type DesktopChoice, type DesktopId, detectDesktop, getDesktop } from "./platform/index.js";
import { pickEncoder } from "./record/backends/pipewire.js";
import { hasX11grab } from "./record/backends/x11-ffmpeg.js";
import { mouseAccess } from "./record/input/evdev.js";
import { ObsRecorder, resolveObsConfig } from "./record/obs.js";
import { installHint } from "./util/distro.js";
import { run } from "./util/exec.js";
import { loadVoiceConfig } from "./voice/config.js";
import { getProvider } from "./voice/index.js";
import { defaultLaunch, LOCAL_PYTHON_ENV, LocalWorker } from "./voice/local.js";

// Environment self-check: every check is isolated and never throws.

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional or not applicable here: not counted as a failure. */
  skipped?: boolean;
}

export interface DoctorReport {
  summary: string;
  checks: Check[];
}

const skip = (detail: string) => ({ ok: true, skipped: true, detail });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const firstLine = (s: string) => s.split("\n")[0]?.trim() ?? "";

async function tool(bin: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await run(bin, ["-version"]);
    return { ok: true, detail: firstLine(stdout) };
  } catch (err) {
    if (process.platform !== "darwin") throw err;
    return { ok: false, detail: `${bin} not found. Install it with Homebrew: \`brew install ffmpeg\` (see https://brew.sh), then restart the AI app.` };
  }
}

/** Moves the real pointer: only runs when asked. */
async function inputCheck(): Promise<{ ok: boolean; detail: string }> {
  const d = await Driver.open();
  try {
    const first = d.screens()[0];
    if (!first) throw new Error("no monitors");
    const start = d.cursor();
    const target = { x: first.x + first.w / 2, y: first.y + first.h / 2 };
    await d.moveToGlobal(target, { dur: 0.3 });
    await sleep(300);
    const seen = d.cursor();
    const dist = Math.hypot(seen.x - target.x, seen.y - target.y);
    await d.moveToGlobal(start, { dur: 0.3 });
    return { ok: dist <= 3, detail: `moved to (${Math.round(target.x)}, ${Math.round(target.y)}) on ${first.name}; watcher read back ${dist.toFixed(1)} px away` };
  } finally {
    await d.close();
  }
}

async function obsCheck(): Promise<Omit<Check, "name">> {
  const cfg = await resolveObsConfig();
  const obs = new ObsRecorder();
  try {
    await withTimeout(obs.connect(cfg), 5000, "OBS connect");
  } catch (err) {
    return skip(`OBS not reachable at ${cfg.url} (optional: only for --recorder obs): ${(err as Error).message}`);
  }
  try {
    const v = await obs.client.call("GetVersion");
    const sources = await obs.listCaptureSources();
    return { ok: true, detail: `OBS ${v.obsVersion}, websocket ${v.obsWebSocketVersion}; capture sources: ${sources.length ? sources.join(", ") : "none"}` };
  } finally {
    await obs.disconnect().catch(() => {});
  }
}

type Add = (name: string, fn: () => Promise<Omit<Check, "name"> | { ok: boolean; detail: string }>) => Promise<void>;

/** macOS privacy permissions (granted to the app that starts us) and avfoundation, with exact fix steps. */
async function macChecks(add: Add): Promise<void> {
  const { quartz } = await import("./platform/macos/quartz.js");
  const { hostApp, permissionHelp } = await import("./platform/macos/permissions.js");
  const { listAvfoundationScreens } = await import("./record/backends/macos-avfoundation.js");
  const app = await hostApp();
  await add("accessibility", async () => {
    const ok = (await quartz()).axTrusted();
    return { ok, detail: ok ? `allowed for ${app} (mouse, keyboard, windows)` : permissionHelp("accessibility", app) };
  });
  await add("screen recording", async () => {
    const ok = (await quartz()).screenCaptureAllowed();
    return { ok, detail: ok ? `allowed for ${app} (recording, screenshots, window titles)` : permissionHelp("screen", app) };
  });
  await add("input monitoring", async () => {
    const access = (await quartz()).inputMonitoring();
    if (access === "granted") return { ok: true, detail: `allowed for ${app} (click logging)` };
    // Optional: without it recordings simply have no click ripples/zooms from real clicks.
    return { ok: true, skipped: true, detail: `${access} (optional). ${permissionHelp("input", app)}` };
  });
  await add("avfoundation", async () => {
    const screens = await listAvfoundationScreens();
    return { ok: screens.length > 0, detail: screens.length ? `${screens.length} capture screen(s)` : "ffmpeg lists no \"Capture screen\" devices (is ffmpeg built with avfoundation?)" };
  });
}

// Per-capability support of the picked desktop backend, with the fix when something is missing.

type Result = Omit<Check, "name">;
const fail = (detail: string): Result => ({ ok: false, detail });

async function gstreamerSupport(): Promise<Result> {
  try {
    await run("gst-inspect-1.0", ["pipewiresrc"]);
  } catch {
    return fail(`GStreamer or its PipeWire plugin (pipewiresrc) is missing: ${installHint("gstreamer")} (or record with --recorder obs)`);
  }
  const enc = await pickEncoder();
  if (!enc) return fail(`no GStreamer H.264 encoder: ${installHint("gstreamer")} (or record with --recorder obs)`);
  return { ok: true, detail: `portal PipeWire streams + GStreamer (${enc})` };
}

export async function recordSupport(id: DesktopId): Promise<Result> {
  switch (id) {
    case "windows":
      return { ok: true, detail: "ffmpeg gdigrab (see the ffmpeg check)" };
    case "macos":
      return { ok: true, detail: "ffmpeg avfoundation (see the screen recording and avfoundation checks)" };
    case "x11":
      return (await hasX11grab())
        ? { ok: true, detail: `ffmpeg x11grab on ${process.env.DISPLAY ?? ":0"}` }
        : fail(`ffmpeg with x11grab is needed: ${installHint("ffmpeg")} (or record with --recorder obs)`);
    case "kde":
      return gstreamerSupport();
    case "portal": {
      if ((await portalVersion("ScreenCast")) === undefined) {
        return fail("xdg-desktop-portal has no ScreenCast interface: install your desktop's portal backend (xdg-desktop-portal-gnome, -wlr or -hyprland) and log in again");
      }
      const gst = await gstreamerSupport();
      const rd = (await portalVersion("RemoteDesktop")) !== undefined;
      return gst.ok ? { ...gst, detail: `${gst.detail}; ${rd ? "RemoteDesktop" : "ScreenCast"} session (asks once)` } : gst;
    }
  }
}

export async function driveSupport(id: DesktopId): Promise<Result> {
  switch (id) {
    case "windows":
      return { ok: true, detail: "SendInput" };
    case "macos":
      return { ok: true, detail: "CGEvent (see the accessibility check)" };
    case "x11": {
      const x = await (await import("./platform/x11/xlib.js")).x11();
      return x.hasXTest() ? { ok: true, detail: "XTest" } : fail("the X server has no XTEST extension");
    }
    case "kde":
    case "portal": {
      const v = await portalVersion("RemoteDesktop");
      if (v !== undefined) return { ok: true, detail: `xdg-desktop-portal RemoteDesktop v${v} (approve once; the token is saved)` };
      if (isWlrootsEnv(process.env)) {
        return skip(`not supported on ${desktopName(process.env)}: wlroots compositors have no RemoteDesktop portal (recording still works)`);
      }
      return fail("xdg-desktop-portal has no RemoteDesktop interface: install your desktop's portal backend (e.g. xdg-desktop-portal-gnome) and log in again");
    }
  }
}

export async function windowSupport(id: DesktopId): Promise<Result> {
  switch (id) {
    case "windows":
      return { ok: true, detail: "Win32" };
    case "macos":
      return { ok: true, detail: "Accessibility API (see the accessibility check)" };
    case "kde":
      return { ok: true, detail: "KWin scripts" };
    case "x11": {
      const { hasEwmh } = await import("./platform/x11/windows.js");
      const x = await (await import("./platform/x11/xlib.js")).x11();
      return hasEwmh(x) ? { ok: true, detail: "EWMH window manager" } : fail("no EWMH window manager is running on this display (window list, focus and fit need one)");
    }
    case "portal":
      return skip(`not available on ${desktopName(process.env)} (Wayland has no window list for apps): focus/fit steps and web targets don't work; window-framed views fall back to screens`);
  }
}

export async function pointerSupport(id: DesktopId): Promise<Result> {
  switch (id) {
    case "windows":
      return { ok: true, detail: "cursor polling + clicks from the global mouse hook" };
    case "macos":
      return { ok: true, detail: "cursor polling + clicks from the global mouse hook (see the input monitoring check)" };
    case "x11":
      return { ok: true, detail: "XQueryPointer polling + clicks from the global mouse hook (uiohook)" };
    case "kde": {
      const { devices, readable } = await mouseAccess();
      if (readable.length) return { ok: true, detail: `pointer from KWin, clicks from ${readable.length} evdev device(s)` };
      return skip(
        devices.length
          ? "pointer from KWin; clicks are NOT logged: run `sudo usermod -aG input $USER` and log in again (that group can read all input)"
          : "pointer from KWin; no mouse devices found for click logging",
      );
    }
    case "portal":
      return skip(`none on ${desktopName(process.env)} (Wayland does not expose the pointer): performed takes still get their clicks from the driver; zooms otherwise come from the storyboard`);
  }
}

export async function doctor(opts: { input?: boolean } = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = async (name: string, fn: () => Promise<Omit<Check, "name"> | { ok: boolean; detail: string }>) => {
    try {
      checks.push({ name, ...(await fn()) });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await add("node", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    return { ok: major >= 22, detail: `${process.version}${major >= 22 ? "" : " (need >= 22)"}` };
  });
  await add("ffmpeg", () => tool("ffmpeg"));
  await add("ffprobe", () => tool("ffprobe"));
  let choice: DesktopChoice | undefined;
  await add("desktop", async () => {
    choice = detectDesktop();
    return { ok: true, detail: `${choice.id} (${choice.reason}; override with ${DESKTOP_ENV}=${DESKTOP_IDS.join("|")})` };
  });
  await add("monitors", async () => {
    const screens = await (await getDesktop()).screens();
    return { ok: screens.length > 0, detail: screens.map((s) => `${s.name} ${s.w}x${s.h}+${s.x}+${s.y}`).join("; ") || "none found" };
  });
  if (choice) {
    const id = choice.id;
    await add("can record (native)", () => recordSupport(id));
    await add("can drive (input injection)", () => driveSupport(id));
    await add("window control", () => windowSupport(id));
    await add("pointer logging", () => pointerSupport(id));
  }
  await add("windows", async () => {
    const desktop = await getDesktop();
    if (!desktop.windowControl) return skip("no window list on this desktop");
    return { ok: true, detail: `${(await desktop.listWindows()).length} windows listed` };
  });
  await add("input injection", async () => (opts.input ? inputCheck() : skip("pass --input to test (it moves the real pointer)")));
  await add("obs", obsCheck);
  await add("demo browser", async () => {
    try {
      return { ok: true, detail: findBrowser() };
    } catch (err) {
      if (process.platform !== "darwin") throw err;
      return { ok: false, detail: `${(err as Error).message} Install Google Chrome (https://www.google.com/chrome) into /Applications.` };
    }
  });
  await add("edge tts", async () => {
    const voices = await withTimeout(getProvider("edge").listVoices(), 10_000, "Edge TTS");
    return { ok: voices.length > 0, detail: `${voices.length} voices` };
  });
  await add("local voice", async () => {
    if (!process.env[LOCAL_PYTHON_ENV] && !loadVoiceConfig().local.python) return skip(`optional, not set up: run "${APP} voice-setup voicetut"`);
    const worker = new LocalWorker(defaultLaunch());
    try {
      const r = (await worker.request({ cmd: "doctor" }, 60_000)) as {
        ok?: boolean;
        error?: string;
        device?: string;
        gpu?: string;
        vram_total_gb?: number;
        models?: Record<string, { installed: boolean; weights: boolean; detail?: string }>;
      };
      if (!r.ok) return { ok: false, detail: r.error ?? "the voice engine did not answer" };
      const models = Object.entries(r.models ?? {});
      const state = (m: { installed: boolean; weights: boolean }) => (!m.installed ? "not installed" : m.weights ? "ready" : "weights not downloaded");
      const where = r.device === "cuda" ? `GPU ${r.gpu ?? ""} ${r.vram_total_gb ?? "?"} GB` : `${r.device ?? "cpu"} (slow: a line takes several times its length)`;
      return { ok: models.some(([, m]) => m.installed && m.weights), detail: `${where}; ${models.map(([n, m]) => `${n}: ${state(m)}`).join(", ")}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    } finally {
      await worker.close();
    }
  });
  await add("render browser", async () => {
    // Don't call `hyperframes browser path`: it downloads Chrome when missing.
    const cache = join(homedir(), ".cache", "hyperframes", "chrome");
    const found =
      process.env.HYPERFRAMES_BROWSER_PATH ||
      (existsSync(cache) && readdirSync(cache).some((d) => d.includes("headless-shell")) ? cache : undefined);
    return found
      ? { ok: true, detail: found }
      : { ok: false, detail: `not downloaded yet; run "${APP} setup" (or the first render downloads ~100 MB)` };
  });
  await add("gstreamer", async () => {
    if (process.platform !== "linux") return skip("Linux only");
    try {
      return { ok: true, detail: firstLine((await run("gst-launch-1.0", ["--version"])).stdout) };
    } catch {
      return { ok: true, skipped: true, detail: "gst-launch-1.0 not found (informational)" };
    }
  });

  if (process.platform === "darwin") await macChecks(add);

  const skipped = checks.filter((c) => c.skipped).length;
  const failed = checks.filter((c) => !c.ok).length;
  const ok = checks.length - skipped - failed;
  return { summary: `${ok} ok, ${failed} failed, ${skipped} skipped`, checks };
}
