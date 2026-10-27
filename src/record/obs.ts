import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { EventSubscription, OBSWebSocket } from "obs-websocket-js";
import { loadState, saveState } from "../drive/state.js";
import type { ScreenInfo } from "./input/types.js";
import { APP, isOurs, named } from "../brand.js";

type SceneItem = Record<string, unknown>;

// Drives OBS Studio through obs-websocket v5 (built into OBS 28+). We record
// a dedicated "demoreel" scene holding one full-screen capture source, so the
// user's own scenes are untouched apart from switching to it while recording.

export const SCENE = APP;
export const SOURCE = named("screen");

// Preference order: Wayland portal, X11, Windows, macOS.
const CAPTURE_KINDS = ["pipewire-screen-capture-source", "xshm_input_v2", "xshm_input", "monitor_capture", "screen_capture"];

export interface ObsConfig {
  url: string;
  password?: string;
}

function obsConfigPaths(): string[] {
  const rel = join("obs-studio", "plugin_config", "obs-websocket", "config.json");
  const paths = [join(homedir(), ".config", rel), join(homedir(), ".var", "app", "com.obsproject.Studio", "config", rel)];
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, rel));
  paths.push(join(homedir(), "Library", "Application Support", rel));
  return paths;
}

/** Fill in the port/password from OBS's own websocket config when not given. */
export async function resolveObsConfig(url?: string, password?: string): Promise<ObsConfig & { serverEnabled?: boolean }> {
  for (const p of obsConfigPaths()) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(await readFile(p, "utf8")) as {
        server_enabled?: boolean;
        server_port?: number;
        server_password?: string;
        auth_required?: boolean;
      };
      return {
        url: url ?? `ws://127.0.0.1:${cfg.server_port ?? 4455}`,
        password: password ?? (cfg.auth_required === false ? undefined : cfg.server_password),
        serverEnabled: cfg.server_enabled,
      };
    } catch {
      // unreadable config: fall through to defaults
    }
  }
  return { url: url ?? "ws://127.0.0.1:4455", password };
}

export interface CaptureInfo {
  /** Size of the captured monitor in pixels. */
  sourceWidth: number;
  sourceHeight: number;
  /** Where the capture sits in the recorded canvas, normalized 0..1. */
  contentRect: { x: number; y: number; w: number; h: number };
  canvas: { width: number; height: number; fps: number };
  inputKind: string;
  sourceName: string;
  /** Multi-monitor recordings: each monitor's rect in the canvas, normalized 0..1. */
  canvasScreens?: { name: string; x: number; y: number; w: number; h: number }[];
}

export const MULTI_SCENE = named("multi");

export interface VideoSettings {
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
}

export class ObsRecorder {
  private obs = new OBSWebSocket();

  /** The underlying obs-websocket client (for layout detection). */
  get client(): OBSWebSocket {
    return this.obs;
  }
  private previousScene?: string;
  private previousRecordDir?: string;
  private previousVideo?: VideoSettings;
  /** performance.now() when OBS reported the recording started. */
  startedAt = 0;

  async connect(cfg: ObsConfig & { serverEnabled?: boolean }): Promise<void> {
    try {
      await this.obs.connect(cfg.url, cfg.password, { eventSubscriptions: EventSubscription.Outputs });
      await this.recoverVideoSettings();
    } catch (err) {
      const hint =
        cfg.serverEnabled === false
          ? "OBS WebSocket server is disabled: in OBS open Tools → WebSocket Server Settings and tick “Enable WebSocket server”."
          : "Is OBS running with its WebSocket server enabled (Tools → WebSocket Server Settings)?";
      throw new Error(`Cannot connect to OBS at ${cfg.url}: ${(err as Error).message}. ${hint}`);
    }
  }

  /** A previous run died mid-recording: put the user's canvas and record folder back. */
  private async recoverVideoSettings(): Promise<void> {
    const state = await loadState();
    if (!state.pendingVideoRestore && !state.pendingRecordDir) return;
    const { outputActive } = await this.obs.call("GetRecordStatus");
    if (outputActive) return;
    if (state.pendingVideoRestore) await this.obs.call("SetVideoSettings", state.pendingVideoRestore);
    if (state.pendingRecordDir) await this.obs.call("SetRecordDirectory", { recordDirectory: state.pendingRecordDir });
    delete state.pendingVideoRestore;
    delete state.pendingRecordDir;
    await saveState(state);
  }

  /** Create (once) the demoreel scene + capture source and switch to it. */
  async prepareScene(log: (m: string) => void, pickTimeoutMs = 90_000): Promise<CaptureInfo> {
    const { scenes, currentProgramSceneName } = await this.obs.call("GetSceneList");
    this.previousScene = currentProgramSceneName;
    if (!scenes.some((s) => s.sceneName === SCENE)) await this.obs.call("CreateScene", { sceneName: SCENE });

    let item = await this.pickCaptureItem(scenes.map((s) => String(s.sceneName)));
    let inputKind = String(item?.inputKind ?? "");
    if (!item) {
      const { inputKinds } = await this.obs.call("GetInputKindList", { unversioned: false });
      inputKind = CAPTURE_KINDS.find((k) => inputKinds.includes(k)) ?? "";
      if (!inputKind) throw new Error(`OBS has no screen capture source kind (have: ${inputKinds.join(", ")})`);
      const existing = (await this.obs.call("GetSceneItemList", { sceneName: SCENE })).sceneItems.find((i) => i.sourceName === SOURCE);
      if (!existing) {
        const settings: Record<string, boolean> = inputKind.startsWith("pipewire")
          ? { ShowCursor: true }
          : { show_cursor: true, capture_cursor: true };
        await this.obs.call("CreateInput", { sceneName: SCENE, inputName: SOURCE, inputKind, inputSettings: settings });
      }
      if (inputKind.startsWith("pipewire")) {
        log(`OBS: in scene "${SCENE}", open the "${SOURCE}" source properties and pick the screen to record (first time only).`);
      }
      item = (await this.obs.call("GetSceneItemList", { sceneName: SCENE })).sceneItems.find((i) => i.sourceName === SOURCE);
    }
    await this.obs.call("SetCurrentProgramScene", { sceneName: SCENE });
    const sceneItemId = Number(item?.sceneItemId);

    const video = await this.obs.call("GetVideoSettings");
    const canvasW = video.baseWidth;
    const canvasH = video.baseHeight;

    // Wait until the capture has real pixels (portal picker may still be open).
    const deadline = Date.now() + pickTimeoutMs;
    let srcW = 0;
    let srcH = 0;
    while (Date.now() < deadline) {
      const { sceneItemTransform: tr } = await this.obs.call("GetSceneItemTransform", { sceneName: SCENE, sceneItemId });
      srcW = Number(tr.sourceWidth);
      srcH = Number(tr.sourceHeight);
      if (srcW > 0 && srcH > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(srcW > 0 && srcH > 0)) {
      throw new Error(
        `The OBS capture source "${String(item?.sourceName)}" shows nothing. In OBS, open its properties and pick a screen, then retry.`,
      );
    }

    // Fit the capture inside the canvas, centered, aspect preserved.
    await this.obs.call("SetSceneItemTransform", {
      sceneName: SCENE,
      sceneItemId,
      sceneItemTransform: {
        boundsType: "OBS_BOUNDS_SCALE_INNER",
        boundsAlignment: 0,
        boundsWidth: canvasW,
        boundsHeight: canvasH,
        positionX: 0,
        positionY: 0,
        alignment: 5, // top-left
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0,
      },
    });
    const scale = Math.min(canvasW / srcW, canvasH / srcH);
    const w = (srcW * scale) / canvasW;
    const h = (srcH * scale) / canvasH;
    return {
      sourceWidth: srcW,
      sourceHeight: srcH,
      contentRect: { x: (1 - w) / 2, y: (1 - h) / 2, w, h },
      canvas: { width: canvasW, height: canvasH, fps: video.fpsNumerator / video.fpsDenominator },
      inputKind,
      sourceName: String(item?.sourceName ?? SOURCE),
    };
  }

  /**
   * Record several monitors side by side: a dedicated OBS profile whose canvas
   * is the union of the monitors (the user's profile stays untouched), and a
   * scene with each monitor's capture placed at its desktop offset.
   */
  async prepareMulti(
    screens: ScreenInfo[],
    layout: { workspace?: string; perScreen: Map<string, string> },
    log: (m: string) => void,
    /** Every monitor (the workspace source shows all of them); defaults to `screens`. */
    allScreens: ScreenInfo[] = screens,
  ): Promise<CaptureInfo> {
    const sourceFor = layout.perScreen;
    const missing = layout.workspace ? [] : screens.filter((s) => !sourceFor.has(s.name));
    if (missing.length) {
      throw new Error(
        `No OBS capture source for ${missing.map((s) => s.name).join(", ")}. In OBS add a Screen Capture source for it ` +
          `(or pass a map like "PC Screen=eDP-1").`,
      );
    }
    const u = unionRect(screens);
    const { scenes, currentProgramSceneName } = await this.obs.call("GetSceneList");
    this.previousScene = currentProgramSceneName;

    // Switching OBS profiles over the websocket can hang OBS 32, so we resize
    // the current profile's canvas for the recording and put it back after.
    // The original is also saved to disk in case we are killed mid-recording.
    const video = await this.obs.call("GetVideoSettings");
    this.previousVideo = video;
    await saveState({ ...(await loadState()), pendingVideoRestore: video });
    await this.obs.call("SetVideoSettings", {
      baseWidth: u.w,
      baseHeight: u.h,
      outputWidth: u.w,
      outputHeight: u.h,
      fpsNumerator: video.fpsNumerator,
      fpsDenominator: video.fpsDenominator,
    });
    log(`OBS canvas ${u.w}x${u.h} for this recording (was ${video.baseWidth}x${video.baseHeight})`);

    if (!scenes.some((s) => s.sceneName === MULTI_SCENE)) await this.obs.call("CreateScene", { sceneName: MULTI_SCENE });
    // One source showing the whole desktop is simplest; else one per monitor at its offset.
    const all = unionRect(allScreens);
    // A workspace source shows every monitor: crop it down to the ones we record.
    const crop = { l: (u.x - all.x) / all.w, t: (u.y - all.y) / all.h, r: (all.x + all.w - u.x - u.w) / all.w, b: (all.y + all.h - u.y - u.h) / all.h };
    const placements = layout.workspace
      ? [{ sourceName: layout.workspace, x: 0, y: 0, w: u.w, h: u.h, crop }]
      : screens.map((scr) => ({ sourceName: sourceFor.get(scr.name)!, x: scr.x - u.x, y: scr.y - u.y, w: scr.w, h: scr.h, crop: undefined }));
    const items = (await this.obs.call("GetSceneItemList", { sceneName: MULTI_SCENE })).sceneItems;
    const wanted = new Set(placements.map((p) => p.sourceName));
    for (const i of items) {
      if (!wanted.has(String(i.sourceName))) await this.obs.call("RemoveSceneItem", { sceneName: MULTI_SCENE, sceneItemId: Number(i.sceneItemId) });
    }
    for (const p of placements) {
      let id = Number(items.find((i) => i.sourceName === p.sourceName)?.sceneItemId ?? NaN);
      if (!Number.isFinite(id)) id = (await this.obs.call("CreateSceneItem", { sceneName: MULTI_SCENE, sourceName: p.sourceName })).sceneItemId;
      await this.obs.call("SetSceneItemEnabled", { sceneName: MULTI_SCENE, sceneItemId: id, sceneItemEnabled: true });
      const { sceneItemTransform: tr } = await this.obs.call("GetSceneItemTransform", { sceneName: MULTI_SCENE, sceneItemId: id });
      const sw = Number(tr.sourceWidth);
      const sh = Number(tr.sourceHeight);
      await this.obs.call("SetSceneItemTransform", {
        sceneName: MULTI_SCENE,
        sceneItemId: id,
        sceneItemTransform: {
          boundsType: "OBS_BOUNDS_SCALE_INNER",
          boundsAlignment: 0,
          boundsWidth: p.w,
          boundsHeight: p.h,
          positionX: p.x,
          positionY: p.y,
          alignment: 5,
          cropLeft: Math.round((p.crop?.l ?? 0) * sw),
          cropRight: Math.round((p.crop?.r ?? 0) * sw),
          cropTop: Math.round((p.crop?.t ?? 0) * sh),
          cropBottom: Math.round((p.crop?.b ?? 0) * sh),
        },
      });
    }
    log(`OBS sources: ${placements.map((p) => `"${p.sourceName}"`).join(" + ")}`);
    await this.obs.call("SetCurrentProgramScene", { sceneName: MULTI_SCENE });
    return {
      sourceWidth: u.w,
      sourceHeight: u.h,
      contentRect: { x: 0, y: 0, w: 1, h: 1 },
      canvas: { width: u.w, height: u.h, fps: video.fpsNumerator / video.fpsDenominator },
      inputKind: "multi",
      sourceName: placements.map((p) => p.sourceName).join(" + "),
      canvasScreens: screens.map((s) => ({
        name: s.name,
        x: (s.x - u.x) / u.w,
        y: (s.y - u.y) / u.h,
        w: s.w / u.w,
        h: s.h / u.h,
      })),
    };
  }

  /** Small JPEG of a source right now (for checking what it captures). */
  async sourceShot(sourceName: string, width = 160): Promise<Buffer> {
    const r = await this.obs.call("GetSourceScreenshot", { sourceName, imageFormat: "jpg", imageWidth: width });
    return Buffer.from(r.imageData.replace(/^data:image\/\w+;base64,/, ""), "base64");
  }

  async listCaptureSources(): Promise<string[]> {
    const { inputs } = await this.obs.call("GetInputList");
    return inputs.filter((i) => CAPTURE_KINDS.includes(String(i.inputKind))).map((i) => String(i.inputName)).filter((n) => !isOurs(n));
  }

  /**
   * A screen capture that already shows pixels, placed in our scene. Reusing
   * one the user set up avoids a new portal session (and its picker dialog).
   */
  private async pickCaptureItem(sceneNames: string[]): Promise<SceneItem | undefined> {
    const size = async (sceneName: string, sceneItemId: number) => {
      const { sceneItemTransform: tr } = await this.obs.call("GetSceneItemTransform", { sceneName, sceneItemId });
      return Number(tr.sourceWidth) * Number(tr.sourceHeight);
    };
    const isCapture = (i: SceneItem) => CAPTURE_KINDS.includes(String(i.inputKind));

    const ours = (await this.obs.call("GetSceneItemList", { sceneName: SCENE })).sceneItems.filter(isCapture);
    for (const i of ours) if ((await size(SCENE, Number(i.sceneItemId))) > 0) return i;

    for (const sceneName of sceneNames.filter((n) => n !== SCENE)) {
      for (const i of (await this.obs.call("GetSceneItemList", { sceneName })).sceneItems.filter(isCapture)) {
        if ((await size(sceneName, Number(i.sceneItemId))) === 0) continue;
        // Show only this capture in our scene.
        for (const o of ours) await this.obs.call("SetSceneItemEnabled", { sceneName: SCENE, sceneItemId: Number(o.sceneItemId), sceneItemEnabled: false });
        await this.obs.call("CreateSceneItem", { sceneName: SCENE, sourceName: String(i.sourceName) });
        return (await this.obs.call("GetSceneItemList", { sceneName: SCENE })).sceneItems.find((x) => x.sourceName === i.sourceName);
      }
    }
    return undefined;
  }

  async start(recordDir: string): Promise<void> {
    const status = await this.obs.call("GetRecordStatus");
    if (status.outputActive) throw new Error("OBS is already recording; stop it first.");
    this.previousRecordDir = (await this.obs.call("GetRecordDirectory")).recordDirectory;
    await saveState({ ...(await loadState()), pendingRecordDir: this.previousRecordDir });
    await this.obs.call("SetRecordDirectory", { recordDirectory: recordDir });
    const started = new Promise<void>((resolve) => {
      const onState = (e: { outputState: string }) => {
        if (e.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
          this.startedAt = performance.now();
          this.obs.off("RecordStateChanged", onState);
          resolve();
        }
      };
      this.obs.on("RecordStateChanged", onState);
    });
    await this.obs.call("StartRecord");
    await Promise.race([started, new Promise((_, rej) => setTimeout(() => rej(new Error("OBS did not start recording")), 15_000))]);
  }

  /** Stop recording and restore the user's scene and record directory. */
  async stop(): Promise<string> {
    // StopRecord answers before the file is finalized; OBS also refuses
    // settings changes until the output has really stopped.
    const stopped = new Promise<string | undefined>((resolve) => {
      const onState = (e: { outputState: string; outputPath?: string }) => {
        if (e.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") {
          this.obs.off("RecordStateChanged", onState);
          resolve(e.outputPath);
        }
      };
      this.obs.on("RecordStateChanged", onState);
      setTimeout(() => resolve(undefined), 20_000);
    });
    const { outputPath } = await this.obs.call("StopRecord");
    const finalPath = (await stopped) ?? outputPath;
    await this.restore();
    return finalPath;
  }

  /** Put back everything we changed; each step on its own so one failure does not skip the rest. */
  async restore(): Promise<void> {
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        // best effort
      }
    };
    if (this.previousVideo) {
      const video = this.previousVideo;
      await attempt(async () => {
        await this.obs.call("SetVideoSettings", video);
        const state = await loadState();
        delete state.pendingVideoRestore;
        await saveState(state);
      });
    }
    if (this.previousRecordDir) {
      const dir = this.previousRecordDir;
      await attempt(async () => {
        await this.obs.call("SetRecordDirectory", { recordDirectory: dir });
        const state = await loadState();
        delete state.pendingRecordDir;
        await saveState(state);
      });
    }
    const scene = this.previousScene;
    if (scene && scene !== SCENE && scene !== MULTI_SCENE) {
      await attempt(() => this.obs.call("SetCurrentProgramScene", { sceneName: scene }));
    }
  }

  async disconnect(): Promise<void> {
    await this.obs.disconnect();
  }
}

export function unionRect(screens: { x: number; y: number; w: number; h: number }[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...screens.map((s) => s.x));
  const y = Math.min(...screens.map((s) => s.y));
  const r = Math.max(...screens.map((s) => s.x + s.w));
  const b = Math.max(...screens.map((s) => s.y + s.h));
  return { x, y, w: r - x, h: b - y };
}
