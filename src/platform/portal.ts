import { spawn } from "node:child_process";
import { charStroke, parseCombo, SHIFT, splitTyping } from "../drive/keys.js";
import { type PortalStream, portalVersion, RemoteDesktopSession } from "../drive/portal.js";
import { loadState, saveState } from "../drive/state.js";
import type { ScreenInfo } from "../record/input/types.js";
import { run } from "../util/exec.js";
import type { Injector, MouseButton } from "./types.js";

// xdg-desktop-portal pieces shared by every Wayland desktop (KDE and the
// generic portal backend): sessions with saved restore tokens, matching
// portal streams to monitors, and input injection through RemoteDesktop.

const BTN: Record<MouseButton, number> = { left: 0x110, right: 0x111, middle: 0x112 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a RemoteDesktop portal session (pointer + keyboard + monitor streams).
 * Restore tokens are single use, so the new one is saved every time.
 */
export async function openRemoteDesktop(log: (m: string) => void, dialog = "the remote control dialog"): Promise<RemoteDesktopSession> {
  const portal = new RemoteDesktopSession();
  const state = await loadState();
  if (!state.remoteDesktopToken) log(`Allow remote control in ${dialog} and select ALL monitors (asked once).`);
  await portal.open(state.remoteDesktopToken);
  if (portal.restoreToken && portal.restoreToken !== state.remoteDesktopToken) {
    await saveState({ ...(await loadState()), remoteDesktopToken: portal.restoreToken });
  }
  return portal;
}

/** A ScreenCast-only session (monitor streams, no input), for compositors without RemoteDesktop. */
export async function openScreenCast(log: (m: string) => void): Promise<RemoteDesktopSession> {
  const portal = new RemoteDesktopSession();
  const state = await loadState();
  if (!state.screenCastToken) log("Allow screen sharing in the dialog and select ALL monitors (asked once).");
  await portal.open(state.screenCastToken, { screenCastOnly: true });
  if (portal.restoreToken && portal.restoreToken !== state.screenCastToken) {
    await saveState({ ...(await loadState()), screenCastToken: portal.restoreToken });
  }
  return portal;
}

/** Monitor streams for recording/screenshots: through RemoteDesktop when the desktop has it (one approval for everything), else ScreenCast. */
export async function openCaptureSession(log: (m: string) => void): Promise<RemoteDesktopSession> {
  return (await portalVersion("RemoteDesktop")) !== undefined ? openRemoteDesktop(log) : openScreenCast(log);
}

/** Match portal streams to monitors: by position, else by size in layout order. */
export function mapStreams(streams: PortalStream[], screens: ScreenInfo[]): Map<string, PortalStream> {
  const out = new Map<string, PortalStream>();
  const free = [...streams];
  for (const s of screens) {
    const i = free.findIndex((st) => st.x === s.x && st.y === s.y && (st.w === 0 || st.w === s.w));
    if (i >= 0) out.set(s.name, free.splice(i, 1)[0]!);
  }
  const positioned = streams.some((st) => st.x !== 0 || st.y !== 0);
  if (!positioned) {
    for (const s of screens.filter((x) => !out.has(x.name))) {
      const i = free.findIndex((st) => st.w === s.w && st.h === s.h);
      if (i >= 0) out.set(s.name, free.splice(i, 1)[0]!);
    }
  }
  return out;
}

export class PortalInjector implements Injector {
  constructor(
    private portal: RemoteDesktopSession,
    private screens: ScreenInfo[],
    private streamOf: Map<string, PortalStream>,
  ) {}

  async moveTo(x: number, y: number): Promise<boolean> {
    const scr = this.screens.find((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
    const stream = scr && this.streamOf.get(scr.name);
    if (!scr || !stream) return false;
    await this.portal.motionAbsolute(stream.node, ((x - scr.x) / scr.w) * stream.w, ((y - scr.y) / scr.h) * stream.h);
    return true;
  }

  async button(b: MouseButton, down: boolean): Promise<void> {
    await this.portal.button(BTN[b], down);
  }

  async wheel(horizontal: boolean, step: 1 | -1): Promise<void> {
    await this.portal.axisDiscrete(horizontal ? 1 : 0, step);
  }

  async pressCombo(combo: string): Promise<void> {
    const syms = parseCombo(combo);
    for (const s of syms) {
      await this.portal.keysym(s, true);
      await sleep(15);
    }
    for (const s of [...syms].reverse()) {
      await this.portal.keysym(s, false);
      await sleep(15);
    }
  }

  /** Latin text key by key (Shift pressed by us), anything else through the clipboard. */
  async typeText(text: string, hooks: { before: () => void; gap: () => number }): Promise<void> {
    for (const part of splitTyping(text)) {
      if (!part.keys) {
        hooks.before();
        await this.paste(part.text);
        continue;
      }
      for (const ch of part.text) {
        hooks.before();
        const { sym, shift } = charStroke(ch)!;
        if (shift) await this.portal.keysym(SHIFT, true);
        await this.portal.keysym(sym, true);
        await sleep(12);
        await this.portal.keysym(sym, false);
        if (shift) await this.portal.keysym(SHIFT, false);
        await sleep(hooks.gap());
      }
    }
  }

  async close(): Promise<void> {
    await this.portal.close();
  }

  private async paste(text: string): Promise<void> {
    let previous: string | undefined;
    try {
      previous = (await run("wl-paste", ["--no-newline"])).stdout;
    } catch {
      previous = undefined;
    }
    await writeClipboard(text);
    await sleep(80);
    await this.pressCombo("ctrl+v");
    await sleep(150);
    if (previous !== undefined) await writeClipboard(previous);
  }
}

function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (err) =>
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error("Typing non-Latin text needs wl-copy (install wl-clipboard).") : err),
    );
    child.on("close", () => resolve());
    child.stdin.end(text);
  });
}

/** Injector for these monitors over a fresh RemoteDesktop session. */
export async function openPortalInjector(screens: ScreenInfo[], log: (m: string) => void, dialog?: string): Promise<PortalInjector> {
  const portal = await openRemoteDesktop(log, dialog);
  const streamOf = mapStreams(portal.streams, screens);
  const missing = screens.filter((s) => !streamOf.has(s.name));
  if (missing.length) log(`No control stream for ${missing.map((s) => s.name).join(", ")}; pointer can't reach it.`);
  return new PortalInjector(portal, screens, streamOf);
}
