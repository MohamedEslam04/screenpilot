import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import type { ScreenInfo } from "../record/input/types.js";
import { getDesktop, type WindowInfo } from "../platform/index.js";
import { APP, configDir } from "../brand.js";

// A clean demo browser (own profile: no personal tabs, bookmarks or logins)
// that we can inspect over CDP to find where page elements are on screen.

export const CDP_PORT = 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a Chromium-based browser may live, best first (the `<APP>_BROWSER` override is handled by findBrowser). */
export function browserCandidates(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const rels = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return rels.flatMap((rel) => roots.map((r) => win32.join(r, rel)));
  }
  if (platform === "darwin") {
    // App bundles in /Applications, or ~/Applications for per-user installs.
    const roots = ["/Applications", ...(env.HOME ? [posix.join(env.HOME, "Applications")] : [])];
    const apps = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"];
    return apps.flatMap((app) => roots.map((r) => posix.join(r, `${app}.app`, "Contents", "MacOS", app)));
  }
  return (env.PATH ?? "").split(posix.delimiter).filter(Boolean).flatMap((dir) => CANDIDATES.map((c) => posix.join(dir, c)));
}

export function findBrowser(): string {
  const envName = `${APP.toUpperCase()}_BROWSER`;
  if (process.env[envName]) return process.env[envName];
  const hit = browserCandidates(process.env, process.platform).find((p) => existsSync(p));
  if (hit) return hit;
  throw new Error(`No Chromium-based browser found (Chrome, Edge, Brave, Chromium); set ${envName}.`);
}

async function cdpUp(): Promise<boolean> {
  try {
    return (await fetch(`${CDP_URL}/json/version`)).ok;
  } catch {
    return false;
  }
}

export interface BrowserWindow {
  window: WindowInfo;
}

/** Start (or reuse) the demo browser and place its window on `screen`. */
export async function openBrowser(opts: { screen?: ScreenInfo; url?: string; log?: (m: string) => void } = {}): Promise<WindowInfo | { note: string }> {
  if (!(await cdpUp())) {
    const profile = join(configDir(), "browser");
    await mkdir(join(profile, "Default"), { recursive: true });
    await quietDownloads(join(profile, "Default", "Preferences"));
    const bin = findBrowser();
    opts.log?.(`starting ${bin} (demo profile)`);
    spawn(
      bin,
      [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${CDP_PORT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--new-window",
        opts.url ?? "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    for (let i = 0; i < 60 && !(await cdpUp()); i++) await sleep(250);
    if (!(await cdpUp())) throw new Error("The demo browser did not open its debugging port.");
  }
  await singleTab(opts.url);
  await allowDownloads();
  const desktop = await getDesktop();
  if (!desktop.windowControl) {
    // No window positions here (e.g. GNOME Wayland): the browser stays where the compositor put it.
    return { note: `The demo browser is open; ${desktop.id} gives no window control, so it was not placed and web targets ({web: selector}) can't be located. Use screen targets.` };
  }
  const win = await browserWindow();
  if (opts.screen) {
    const s = opts.screen;
    await (await getDesktop()).focusWindow(win.id, { screen: s.name });
    await sleep(400);
  } else {
    await (await getDesktop()).focusWindow(win.id);
  }
  return (await (await getDesktop()).listWindows()).find((w) => w.id === win.id) ?? win;
}

/**
 * The demo browser's window, matched by the browser process id (from CDP),
 * never by title: other browser windows of the user must not be touched.
 */
export async function browserWindow(): Promise<WindowInfo> {
  const b = await connect();
  const cdp = await b.newBrowserCDPSession();
  const info = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
  await cdp.detach();
  const pid = info.processInfo.find((p) => p.type === "browser")?.id;
  if (!pid) throw new Error("CDP did not report the browser process id.");
  const desktop = await getDesktop();
  if (!desktop.windowControl) {
    throw new Error(`Web targets need the browser window's position, which ${desktop.id} does not give apps (Wayland). Use screen targets ({screen, x, y}).`);
  }
  for (let i = 0; i < 20; i++) {
    const hit = (await (await getDesktop()).listWindows()).find((w) => w.pid === pid);
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`No window found for the demo browser (pid ${pid}).`);
}

/**
 * Some browsers (Brave) ask where to save every download, which would stall a
 * take, and show first-run infobars. Must be written while the browser is not running.
 */
async function quietDownloads(prefsPath: string): Promise<void> {
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(await readFile(prefsPath, "utf8")) as Record<string, unknown>;
  } catch {
    // fresh profile
  }
  const download = { ...(prefs.download as Record<string, unknown> | undefined), prompt_for_download: false, default_directory: downloadsDir() };
  const savefile = { ...(prefs.savefile as Record<string, unknown> | undefined), default_directory: downloadsDir() };
  await writeFile(prefsPath, JSON.stringify({ ...prefs, download, savefile }));
  await acknowledgeBraveAnalytics(join(dirname(dirname(prefsPath)), "Local State"));
}

/**
 * Brave's "privacy-preserving product analytics" infobar would sit on top of
 * every page in the video. It is a browser-wide (Local State) setting.
 */
async function acknowledgeBraveAnalytics(localStatePath: string): Promise<void> {
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(await readFile(localStatePath, "utf8")) as Record<string, unknown>;
  } catch {
    // fresh profile
  }
  const brave = (state.brave as Record<string, unknown> | undefined) ?? {};
  const p3a = { ...(brave.p3a as Record<string, unknown> | undefined), enabled: false, notice_acknowledged: true };
  await writeFile(localStatePath, JSON.stringify({ ...state, brave: { ...brave, p3a } }));
}

export function downloadsDir(): string {
  return process.env.XDG_DOWNLOAD_DIR ?? join(homedir(), "Downloads");
}

/** Downloads land in ~/Downloads without a "Save as" dialog, so takes can open them. */
async function allowDownloads(): Promise<void> {
  const b = await connect();
  const cdp = await b.newBrowserCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadsDir(), eventsEnabled: true });
  await cdp.detach();
}

/**
 * Keep exactly one tab: browsers restore old tabs on restart, and CDP cannot
 * tell which tab is on screen (all report "visible"), so extra tabs would make
 * us aim at a hidden page.
 */
async function singleTab(url?: string): Promise<void> {
  const b = await connect();
  const pages = b.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith("devtools://"));
  const keep = pages.at(-1) ?? (await b.contexts()[0]!.newPage());
  for (const p of pages) if (p !== keep) await p.close().catch(() => {});
  // Always load fresh: a page left over from an earlier take keeps its typed state.
  if (url) await keep.goto(url);
  await keep.bringToFront();
}

let browser: Browser | undefined;

async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

/** Run with the tab the viewer actually sees (CDP lists background tabs too). */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await connect();
  const pages = b.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith("devtools://"));
  if (pages.length === 0) throw new Error("The demo browser has no open tab.");
  let page = pages.at(-1)!;
  for (const p of pages) {
    const visible = await p.evaluate(() => document.visibilityState === "visible").catch(() => false);
    if (visible) {
      page = p;
      break;
    }
  }
  return fn(page);
}

export async function disconnectBrowser(): Promise<void> {
  // Only drops our CDP connection; the browser keeps running.
  browser = undefined;
}

interface Metrics {
  iw: number;
  ih: number;
  ow: number;
  oh: number;
}

/** Per window geometry + viewport size: how far our estimate is from where the page really is. */
const calibration = new Map<string, { dx: number; dy: number }>();

/**
 * Screen position (global logical px) of an element's centre. The page knows
 * where the element is in CSS px and KWin knows where the window is; the
 * browser's own chrome (toolbar, infobars, client-side decorations) is
 * measured once by moving the real pointer and asking the page where it
 * landed, so clicks hit exactly.
 */
export async function locate(
  selector: string,
  pointer: PointerMover,
  timeoutMs = 10_000,
): Promise<{ x: number; y: number; w: number; h: number }> {
  const win = await browserWindow();
  return withPage(async (page) => {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: timeoutMs });
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    if (!box) throw new Error(`"${selector}" has no box on screen`);
    const m = await metrics(page);
    const key = `${win.id}:${win.x},${win.y},${win.w},${win.h}:${m.iw}x${m.ih}`;
    let c = calibration.get(key);
    if (!c) {
      c = await calibrate(page, m, win, pointer);
      calibration.set(key, c);
    }
    const p = contentToScreen(box, m, win);
    return { ...p, x: p.x + c.dx, y: p.y + c.dy };
  });
}

export interface PointerMover {
  moveToGlobal(to: { x: number; y: number }, opts?: { dur?: number }): Promise<void>;
}

const metrics = (page: Page): Promise<Metrics> =>
  page.evaluate(() => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight }));

async function calibrate(page: Page, m: Metrics, win: WindowInfo, pointer: PointerMover): Promise<{ dx: number; dy: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __screenpilotPointer: { x: number; y: number } | null };
    w.__screenpilotPointer = null;
    addEventListener("mousemove", (e) => (w.__screenpilotPointer = { x: e.clientX, y: e.clientY }), { capture: true });
  });
  const target = { x: m.iw / 2, y: m.ih / 2 };
  const est = contentToScreen({ ...target, width: 0, height: 0 }, m, win);
  await pointer.moveToGlobal({ x: est.x - 8, y: est.y - 8 }, { dur: 0.25 });
  await pointer.moveToGlobal(est, { dur: 0.12 });
  await sleep(150);
  const got = await page.evaluate(() => (window as unknown as { __screenpilotPointer: { x: number; y: number } | null }).__screenpilotPointer);
  if (!got) throw new Error("Calibration failed: the page saw no pointer movement (is the browser window visible?)");
  const k = win.w / m.ow;
  return { dx: (target.x - got.x) * k, dy: (target.y - got.y) * k };
}

export function contentToScreen(
  box: { x: number; y: number; width: number; height: number },
  m: { iw: number; ih: number; ow: number; oh: number },
  win: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const k = win.w / m.ow; // logical px per CSS px
  const left = win.x + (win.w - m.iw * k) / 2;
  const top = win.y + win.h - m.ih * k;
  return {
    x: left + (box.x + box.width / 2) * k,
    y: top + (box.y + box.height / 2) * k,
    w: box.width * k,
    h: box.height * k,
  };
}

export async function waitForWeb(selector: string, timeoutMs = 30_000): Promise<void> {
  await withPage((p) => p.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs }));
}
