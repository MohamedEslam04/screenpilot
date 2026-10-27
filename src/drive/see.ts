import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSWebSocket } from "obs-websocket-js";
import { type Rect, screenForSourceName, type ScreenInfo } from "../record/input/types.js";
import { MULTI_SCENE, resolveObsConfig, unionRect } from "../record/obs.js";
import { run } from "../util/exec.js";
import { probeVideo } from "../util/media.js";
import { loadState } from "./state.js";
import { isOurs, named } from "../brand.js";
import { getDesktop } from "../platform/index.js";
import { gstAvailable, snapshotMonitors } from "../record/backends/kde-pipewire.js";
import { isKde } from "../record/input/kwin.js";

// Current pictures of each monitor, straight from OBS's capture sources (no
// extra screen-share permission needed), and which source shows which monitor.

const CAPTURE_KINDS = ["pipewire-screen-capture-source", "xshm_input_v2", "xshm_input", "monitor_capture", "screen_capture"];

/** Monitor name → OBS source name, from saved choices, name matching, then elimination. */
export function mapSources(sources: string[], screens: ScreenInfo[], saved: Record<string, string> = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const [src, scr] of Object.entries(saved)) if (sources.includes(src) && screens.some((s) => s.name === scr)) out.set(scr, src);
  for (const src of sources) {
    if ([...out.values()].includes(src)) continue;
    const s = screenForSourceName(screens.filter((x) => !out.has(x.name)), src);
    if (s) out.set(s.name, src);
  }
  const freeSrc = sources.filter((s) => ![...out.values()].includes(s));
  const freeScr = screens.filter((s) => !out.has(s.name));
  if (freeSrc.length === 1 && freeScr.length === 1) out.set(freeScr[0]!.name, freeSrc[0]!);
  return out;
}

export async function captureSources(obs: OBSWebSocket): Promise<string[]> {
  const { inputs } = await obs.call("GetInputList");
  return inputs
    .filter((i) => CAPTURE_KINDS.includes(String(i.inputKind)))
    .map((i) => String(i.inputName))
    .filter((n) => !isOurs(n));
}

export interface CaptureLayout {
  /** A source showing the whole desktop (all monitors side by side). */
  workspace?: string;
  /** Monitor → source showing only that monitor. */
  perScreen: Map<string, string>;
  warnings: string[];
}

/**
 * Work out which OBS source shows which monitor by looking at the pictures:
 * a source with the desktop's aspect is the whole workspace, and each
 * single-monitor source is matched to the workspace crop it looks like.
 * Falls back to names (and saved choices) when there is no workspace source.
 */
export async function detectLayout(obs: OBSWebSocket, screens: ScreenInfo[]): Promise<CaptureLayout> {
  const sources = await captureSources(obs);
  // Some OSes say exactly which monitor a source captures (Windows: monitor_id).
  const desktop = await getDesktop().catch(() => undefined);
  if (desktop?.sourceMonitor) {
    const perScreen = new Map<string, string>();
    const { inputs } = await obs.call("GetInputList");
    for (const src of sources) {
      const kind = String(inputs.find((i) => i.inputName === src)?.inputKind ?? "");
      const { inputSettings } = await obs.call("GetInputSettings", { inputName: src });
      const monitor = desktop.sourceMonitor(kind, inputSettings, screens);
      if (monitor && !perScreen.has(monitor)) perScreen.set(monitor, src);
    }
    if (screens.every((s) => perScreen.has(s.name))) return { perScreen, warnings: [] };
  }
  const restore = await showSources(obs, sources);
  const dir = await mkdtemp(join(tmpdir(), named("layout-")));
  try {
    const shots: { src: string; file: string; aspect: number }[] = [];
    for (const src of sources) {
      const file = join(dir, `${shots.length}.jpg`);
      try {
        await writeFile(file, await sourceShot(obs, src, 640));
      } catch {
        continue; // not rendering
      }
      const info = await probeVideo(file);
      shots.push({ src, file, aspect: info.width / info.height });
    }
    const u = unionRect(screens);
    const near = (a: number, b: number) => Math.abs(a - b) / b < 0.04;
    const ws = screens.length > 1 ? shots.find((s) => near(s.aspect, u.w / u.h)) : undefined;
    const warnings: string[] = [];
    if (!ws) {
      const perScreen = mapSources(
        shots.map((s) => s.src),
        screens,
        (await loadState()).sourceMap,
      );
      for (const [a, b] of pairs([...perScreen.entries()])) {
        const fa = shots.find((s) => s.src === a[1])!.file;
        const fb = shots.find((s) => s.src === b[1])!.file;
        if ((await imageDiff(fa, fb)) < 4) {
          warnings.push(`OBS sources "${a[1]}" and "${b[1]}" show the same picture; one of them is not capturing ${b[0]}. Pick the right screen in its properties.`);
        }
      }
      return { perScreen, warnings };
    }

    const perScreen = new Map<string, string>();
    const crops = new Map<string, string>();
    for (const s of screens) {
      const file = join(dir, `crop-${s.name}.jpg`);
      await cropNormalized(ws.file, rel(s, u), file);
      crops.set(s.name, file);
    }
    for (const shot of shots.filter((s) => s !== ws)) {
      let best: { screen: string; diff: number } | undefined;
      for (const s of screens) {
        const diff = await imageDiff(shot.file, crops.get(s.name)!);
        if (!best || diff < best.diff) best = { screen: s.name, diff };
      }
      if (best && best.diff < 14 && !perScreen.has(best.screen)) perScreen.set(best.screen, shot.src);
    }
    return { workspace: ws.src, perScreen, warnings };
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (restore) await obs.call("SetCurrentProgramScene", { sceneName: restore }).catch(() => {});
  }
}

export interface Shot {
  screen: string;
  file: string;
}

export async function screenshot(
  screens: ScreenInfo[],
  opts: { only?: string; outDir: string; width?: number; grid?: boolean },
): Promise<{ shots: Shot[]; warnings: string[] }> {
  // Native first (no OBS): KDE reads the portal's monitor streams.
  if (process.platform === "linux" && isKde() && (await gstAvailable())) {
    const wanted = opts.only ? screens.filter((s) => s.name === opts.only) : screens;
    if (opts.only && wanted.length === 0) throw new Error(`No monitor named "${opts.only}"`);
    await mkdir(opts.outDir, { recursive: true });
    const fileOf = (s: ScreenInfo) => join(opts.outDir, `${s.name}.jpg`);
    await snapshotMonitors(wanted, fileOf, opts.width ?? 1280);
    const shots = wanted.map((s) => ({ screen: s.name, file: fileOf(s) }));
    if (opts.grid) for (const s of shots) await overlayGrid(s.file);
    return { shots, warnings: [] };
  }
  // Windows: one gdigrab frame per monitor.
  if (process.platform === "win32") {
    const { gdigrabStillArgs } = await import("../record/backends/windows-ffmpeg.js");
    const wanted = opts.only ? screens.filter((s) => s.name === opts.only) : screens;
    if (opts.only && wanted.length === 0) throw new Error(`No monitor named "${opts.only}"`);
    await mkdir(opts.outDir, { recursive: true });
    const shots: Shot[] = [];
    for (const [i, s] of wanted.entries()) {
      // Monitor names look like \\.\DISPLAY1: not usable in file names.
      const file = join(opts.outDir, `screen-${i + 1}.jpg`);
      await run("ffmpeg", gdigrabStillArgs(s, file, opts.width ?? 1280));
      shots.push({ screen: s.name, file });
    }
    if (opts.grid) for (const s of shots) await overlayGrid(s.file);
    return { shots, warnings: [] };
  }
  // macOS: `screencapture` of each display's point rect (the image comes out in pixels), scaled down by ffmpeg.
  if (process.platform === "darwin") {
    const { screencaptureArgs } = await import("../record/backends/macos-avfoundation.js");
    const { ensureScreenCapture } = await import("../platform/macos/desktop.js");
    await ensureScreenCapture();
    const wanted = opts.only ? screens.filter((s) => s.name === opts.only) : screens;
    if (opts.only && wanted.length === 0) throw new Error(`No monitor named "${opts.only}"`);
    await mkdir(opts.outDir, { recursive: true });
    const shots: Shot[] = [];
    for (const [i, s] of wanted.entries()) {
      // Display names have spaces and parentheses: number the files instead.
      const file = join(opts.outDir, `screen-${i + 1}.jpg`);
      const png = `${file}.png`;
      await run("screencapture", screencaptureArgs(s, png));
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", png, "-vf", `scale=${opts.width ?? 1280}:-2`, "-q:v", "3", "-y", file]);
      await rm(png, { force: true });
      shots.push({ screen: s.name, file });
    }
    if (opts.grid) for (const s of shots) await overlayGrid(s.file);
    return { shots, warnings: [] };
  }
  const cfg = await resolveObsConfig();
  const obs = new OBSWebSocket();
  await obs.connect(cfg.url, cfg.password);
  try {
    const layout = await detectLayout(obs, screens);
    const wanted = opts.only ? screens.filter((s) => s.name === opts.only) : screens;
    await mkdir(opts.outDir, { recursive: true });
    const needed = [...new Set(wanted.map((s) => layout.perScreen.get(s.name) ?? layout.workspace).filter((x): x is string => !!x))];
    const restore = await showSources(obs, needed);
    const width = opts.width ?? 1280;
    const u = unionRect(screens);
    const shots: Shot[] = [];
    try {
      for (const s of wanted) {
        const file = join(opts.outDir, `${s.name}.jpg`);
        const own = layout.perScreen.get(s.name);
        if (own) {
          await writeFile(file, await sourceShot(obs, own, width));
        } else if (layout.workspace) {
          const whole = `${file}.whole.jpg`;
          await writeFile(whole, await sourceShot(obs, layout.workspace, Math.round(width * (u.w / s.w))));
          await cropNormalized(whole, rel(s, u), file);
          await rm(whole, { force: true });
        } else {
          throw new Error(`No OBS capture source shows ${s.name}. Add a Screen Capture source for it in OBS.`);
        }
        shots.push({ screen: s.name, file });
      }
    } finally {
      if (restore) await obs.call("SetCurrentProgramScene", { sceneName: restore }).catch(() => {});
    }
    if (opts.grid) for (const s of shots) await overlayGrid(s.file);
    return { shots, warnings: layout.warnings };
  } finally {
    await obs.disconnect();
  }
}

export async function sourceShot(obs: OBSWebSocket, sourceName: string, width: number): Promise<Buffer> {
  const r = await obs.call("GetSourceScreenshot", { sourceName, imageFormat: "jpg", imageWidth: width, imageCompressionQuality: 85 });
  return Buffer.from(r.imageData.replace(/^data:image\/\w+;base64,/, ""), "base64");
}

/**
 * OBS only renders sources that are on the program scene. If some are not,
 * show our multi-monitor scene (holding all of them) for the moment of the
 * screenshot; returns the scene to switch back to.
 */
async function showSources(obs: OBSWebSocket, sources: string[]): Promise<string | undefined> {
  const hidden: string[] = [];
  for (const s of sources) if (!(await obs.call("GetSourceActive", { sourceName: s })).videoShowing) hidden.push(s);
  if (hidden.length === 0) return undefined;
  const { scenes, currentProgramSceneName } = await obs.call("GetSceneList");
  if (!scenes.some((s) => s.sceneName === MULTI_SCENE)) await obs.call("CreateScene", { sceneName: MULTI_SCENE });
  const items = (await obs.call("GetSceneItemList", { sceneName: MULTI_SCENE })).sceneItems.map((i) => String(i.sourceName));
  for (const s of sources) if (!items.includes(s)) await obs.call("CreateSceneItem", { sceneName: MULTI_SCENE, sourceName: s });
  await obs.call("SetCurrentProgramScene", { sceneName: MULTI_SCENE });
  await new Promise((r) => setTimeout(r, 900)); // PipeWire streams resume
  return currentProgramSceneName === MULTI_SCENE ? undefined : currentProgramSceneName;
}

const rel = (s: Rect, u: Rect): Rect => ({ x: (s.x - u.x) / u.w, y: (s.y - u.y) / u.h, w: s.w / u.w, h: s.h / u.h });

function* pairs<T>(xs: T[]): Generator<[T, T]> {
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) yield [xs[i]!, xs[j]!];
}

async function cropNormalized(input: string, r: Rect, output: string): Promise<void> {
  const crop = `crop=iw*${r.w.toFixed(5)}:ih*${r.h.toFixed(5)}:iw*${r.x.toFixed(5)}:ih*${r.y.toFixed(5)}`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-vf", crop, "-pix_fmt", "yuvj420p", "-q:v", "3", output]);
}

/** Mean absolute difference (0..255) of tiny grayscale thumbnails. */
export async function imageDiff(a: string, b: string): Promise<number> {
  const thumb = (f: string) => runBinary("ffmpeg", ["-loglevel", "error", "-i", f, "-vf", "scale=48:27,format=gray", "-f", "rawvideo", "-"]);
  const [x, y] = [await thumb(a), await thumb(b)];
  if (x.length !== y.length || x.length === 0) return 255;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff += Math.abs(x[i]! - y[i]!);
  return diff / x.length;
}

export async function sameImage(a: string, b: string, tolerance = 4): Promise<boolean> {
  return (await imageDiff(a, b)) < tolerance;
}

function runBinary(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function overlayGrid(file: string): Promise<void> {
  const box = "box=1:boxcolor=black@0.6:boxborderw=3:fontcolor=white:fontsize=14";
  const parts = ["drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.35"];
  for (let i = 1; i < 10; i++) {
    const v = (i / 10).toFixed(1);
    parts.push(`drawtext=text='${v}':x=w*${v}-12:y=4:${box}`, `drawtext=text='${v}':x=4:y=h*${v}-8:${box}`);
  }
  const tmp = `${file}.grid.jpg`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", parts.join(","), "-q:v", "3", tmp]);
  await run("mv", [tmp, file]);
}
