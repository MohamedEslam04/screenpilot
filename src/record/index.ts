import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { probeVideo } from "../util/media.js";
import { startAdapter } from "./input/index.js";
import { type Rect, type ScreenInfo, screenAt, screenForSourceName } from "./input/types.js";
import { normalizeEvents, normalizeWindows } from "./normalize.js";
import type { RecorderBackend, RecorderId } from "./backend.js";
import { gstAvailable, KdePipewireBackend } from "./backends/kde-pipewire.js";
import { ObsBackend } from "./backends/obs.js";
import { isKde } from "./input/kwin.js";
import { getDesktop, type Watcher } from "../platform/index.js";
import { detectLayout } from "../drive/see.js";
import { loadState, saveState } from "../drive/state.js";
import { type CaptureInfo, ObsRecorder, resolveObsConfig, unionRect } from "./obs.js";
import { APP, sessionsRoot } from "../brand.js";

// Public recording API (used by the CLI and the MCP server).

export type InputAdapterId = "auto" | "kwin" | "uiohook" | "none";

export interface RecordOptions {
  /** Session directory. Default: ./sessions/<timestamp> */
  dir?: string;
  /** obs-websocket URL. Default ws://127.0.0.1:4455 */
  obsUrl?: string;
  /** Default: read from the local OBS config if present. */
  obsPassword?: string;
  input?: InputAdapterId;
  /** Monitor name to normalize pointer coordinates against (e.g. eDP-1). Default: the one under the cursor. */
  screen?: string;
  /** Record several monitors side by side ("all" or names). Needs KWin for the layout. */
  screens?: "all" | string[];
  /** OBS source name → monitor name, when names don't make it obvious (saved for next time). */
  map?: Record<string, string>;
  /** Resize the window matching this (class or title) to 16:9 for the recording; put back after. */
  fitWindow?: string;
  /** "native" (no OBS: PipeWire on KDE, ffmpeg on Windows and macOS) or "obs". Default: native when available. */
  recorder?: RecorderId;
  /** Close notification popups on screen and hold new ones while recording (default true). */
  quiet?: boolean;
  log?: (msg: string) => void;
}

export interface RecordResult {
  dir: string;
  video: string;
  events: string | null;
  meta: string;
  duration: number;
  eventCount: number;
  inputAdapter: string;
  warnings: string[];
}

export interface ActiveRecording {
  dir: string;
  startedAt: number;
  inputAdapter: string;
  stop(): Promise<RecordResult>;
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** Monitor whose pixels OBS records: explicit name > OBS source name match > only monitor > under the cursor. */
export function chooseScreen(
  screens: ScreenInfo[],
  sourceName: string,
  cursor: { x: number; y: number } | undefined,
  wanted?: string,
): { screen?: ScreenInfo; warning?: string } {
  if (screens.length === 0) return {};
  if (wanted) {
    const s = screens.find((x) => x.name === wanted);
    if (!s) throw new Error(`No monitor named "${wanted}" (have: ${screens.map((x) => x.name).join(", ")})`);
    return { screen: s };
  }
  if (screens.length === 1) return { screen: screens[0] };
  const byName = screenForSourceName(screens, sourceName);
  if (byName) return { screen: byName };
  const under = cursor && screenAt(screens, cursor.x, cursor.y);
  if (!under) return { warning: "Could not tell which monitor OBS records; pointer events may be off. Pass screen." };
  return {
    screen: under,
    warning: `Assuming OBS source "${sourceName}" is ${under.name} (monitor under the cursor). If not, run \`${APP} remap <session> --screen <name>\` (have: ${screens.map((x) => x.name).join(", ")}).`,
  };
}

function sessionName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export async function startRecording(opts: RecordOptions = {}): Promise<ActiveRecording> {
  const log = opts.log ?? (() => {});
  const dir = resolve(opts.dir ?? join(sessionsRoot(), sessionName()));
  await mkdir(dir, { recursive: true });

  const recorder = opts.recorder ?? (await defaultRecorder());
  let backend: RecorderBackend | undefined;
  let adapter: Awaited<ReturnType<typeof startAdapter>> | undefined;
  try {
    adapter = await startAdapter(opts.input ?? "auto");
    const warnings = [...adapter.warnings];
    const screens: ScreenInfo[] = adapter.screens();

    let capture: CaptureInfo;
    let screen: Rect;
    if (recorder === "native") {
      const chosen = chooseScreens(screens, opts, adapter.cursor());
      backend = await nativeBackend();
      capture = await backend.prepare(chosen, screens, log);
      screen = unionRect(chosen);
      log(`recording ${chosen.map((s) => s.name).join(" + ")} (native)`);
    } else {
      const obs = new ObsRecorder();
      backend = new ObsBackend(obs);
      await obs.connect(await resolveObsConfig(opts.obsUrl, opts.obsPassword));
      if (opts.screens) {
        // Several monitors side by side in one canvas.
        const chosen = chooseScreens(screens, opts, adapter.cursor());
        const state = await loadState();
        if (opts.map && Object.keys(opts.map).length) await saveState({ ...state, sourceMap: { ...state.sourceMap, ...opts.map } });
        const layout = await detectLayout(obs.client, screens);
        for (const [src, scr] of Object.entries(opts.map ?? {})) layout.perScreen.set(scr, src);
        if (layout.warnings.length && !layout.workspace) throw new Error(layout.warnings.join("\n"));
        warnings.push(...layout.warnings);
        capture = await obs.prepareMulti(chosen, layout, log, screens);
        screen = unionRect(chosen);
      } else {
        capture = await obs.prepareScene(log);
        // Which monitor are we recording? Needed to place pointer events.
        const pick = chooseScreen(screens, capture.sourceName, adapter.cursor(), opts.screen);
        screen = pick.screen ?? { x: 0, y: 0, w: capture.sourceWidth, h: capture.sourceHeight };
        if (pick.warning) warnings.push(pick.warning);
        log(`OBS source "${capture.sourceName}"${pick.screen ? ` → pointer mapped to ${pick.screen.name}` : ""}`);
      }
    }
    const rec = backend;

    // Window fitting and notification handling need a supported desktop (KDE, Windows).
    const desktop = await getDesktop().catch(() => undefined);
    let unfit = async () => {};
    if (opts.fitWindow) {
      if (!desktop) throw new Error("--fit-window needs KDE Plasma, Windows or macOS");
      const fitted = await desktop.fitWindow(opts.fitWindow);
      unfit = fitted.restore;
      log(`fitted "${fitted.window.caption}" to 16:9 (restored after recording)`);
    }
    const unquiet = opts.quiet === false || !desktop ? async () => {} : await desktop.quietNotifications();
    if (opts.quiet !== false && desktop) {
      const closed = await desktop.closeNotificationPopups().catch(() => 0);
      if (closed) log(`closed ${closed} notification popup(s) before recording`);
    }
    try {
      await rec.start(dir);
    } catch (err) {
      await unquiet();
      await unfit();
      throw err;
    }
    log(`recording → ${dir}`);
    const a = adapter;

    return {
      dir,
      startedAt: rec.startedAt,
      inputAdapter: a.id,
      async stop(): Promise<RecordResult> {
        let output: string;
        try {
          output = await rec.stop();
        } finally {
          await unquiet(); // a long-lived MCP server must not keep notifications held
          await unfit();
        }
        await a.stop();
        await rec.dispose();
        warnings.push(...a.warnings.filter((w) => !warnings.includes(w)));

        // Raw pointer log (desktop pixels, ms since start) so `remap` can fix a wrong monitor guess later.
        const raw = a.events.map((e) => ({ ...e, at: Math.round((e.at - rec.startedAt) * 10) / 10 }));
        const events = normalizeEvents(raw, 0, screen, capture.contentRect);
        const eventsPath = a.id === "none" ? null : join(dir, "events.jsonl");
        if (eventsPath) {
          await writeJsonl(eventsPath, events);
          await writeJsonl(join(dir, "pointer.raw.jsonl"), raw);
        }
        // Active window over time, in recording coordinates (for window-framed views).
        const focus = "focus" in a ? normalizeWindows((a as Watcher).focus, rec.startedAt, screen, capture.contentRect) : [];
        if (focus.length) await writeJsonl(join(dir, "windows.jsonl"), focus);
        const info = await probeVideo(output);
        const metaPath = join(dir, "meta.json");
        await writeFile(
          metaPath,
          `${JSON.stringify(
            {
              version: 1,
              video: basename(output),
              events: eventsPath ? "events.jsonl" : null,
              windows: focus.length ? "windows.jsonl" : null,
              recordedAt: new Date(Date.now() - info.duration * 1000).toISOString(),
              inputAdapter: a.id,
              recorder: rec.id,
              screen,
              screens,
              ...(capture.canvasScreens ? { canvasScreens: capture.canvasScreens } : {}),
              capture,
              videoInfo: info,
              warnings,
            },
            null,
            2,
          )}\n`,
        );
        return {
          dir,
          video: output,
          events: eventsPath,
          meta: metaPath,
          duration: info.duration,
          eventCount: events.length,
          inputAdapter: a.id,
          warnings,
        };
      },
    };
  } catch (err) {
    await adapter?.stop().catch(() => {});
    await backend?.restore().catch(() => {});
    await backend?.dispose().catch(() => {});
    throw err;
  }
}

/** Native capture when this OS has it (no OBS needed), else OBS. */
export async function defaultRecorder(): Promise<RecorderId> {
  if (process.platform === "win32" || process.platform === "darwin") return "native";
  if (process.platform === "linux" && isKde() && (await gstAvailable())) return "native";
  return "obs";
}

async function nativeBackend(): Promise<RecorderBackend> {
  if (process.platform === "linux") return new KdePipewireBackend();
  if (process.platform === "win32") return (await import("./backends/windows-ffmpeg.js")).windowsFfmpegBackend();
  if (process.platform === "darwin") {
    const { displays, ensureScreenCapture } = await import("../platform/macos/desktop.js");
    return (await import("./backends/macos-avfoundation.js")).macAvfoundationBackend({ displays, ensureScreenCapture });
  }
  throw new Error(`Native recording is not available on ${process.platform}; use --recorder obs`);
}

/** Monitors to record: "all", a list, one named monitor, or the one under the cursor. */
export function chooseScreens(
  screens: ScreenInfo[],
  opts: { screens?: "all" | string[]; screen?: string },
  cursor: { x: number; y: number } | undefined,
): ScreenInfo[] {
  if (screens.length === 0) throw new Error("Could not read the monitor layout from the desktop.");
  if (opts.screens) {
    const chosen = opts.screens === "all" ? screens : screens.filter((s) => opts.screens!.includes(s.name));
    if (chosen.length === 0) throw new Error(`No such monitors (have: ${screens.map((s) => s.name).join(", ")})`);
    return chosen;
  }
  if (opts.screen) {
    const s = screens.find((x) => x.name === opts.screen);
    if (!s) throw new Error(`No monitor named "${opts.screen}" (have: ${screens.map((x) => x.name).join(", ")})`);
    return [s];
  }
  return [(cursor && screenAt(screens, cursor.x, cursor.y)) ?? screens[0]!];
}
