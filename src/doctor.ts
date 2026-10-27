import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP } from "./brand.js";
import { Driver } from "./drive/index.js";
import { findBrowser } from "./drive/web.js";
import { getDesktop } from "./platform/index.js";
import { ObsRecorder, resolveObsConfig } from "./record/obs.js";
import { run } from "./util/exec.js";
import { getProvider } from "./voice/index.js";

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
  const { stdout } = await run(bin, ["-version"]);
  return { ok: true, detail: firstLine(stdout) };
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
    return skip(`OBS not reachable at ${cfg.url} (optional, needed to record): ${(err as Error).message}`);
  }
  try {
    const v = await obs.client.call("GetVersion");
    const sources = await obs.listCaptureSources();
    return { ok: true, detail: `OBS ${v.obsVersion}, websocket ${v.obsWebSocketVersion}; capture sources: ${sources.length ? sources.join(", ") : "none"}` };
  } finally {
    await obs.disconnect().catch(() => {});
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
  await add("desktop", async () => ({ ok: true, detail: (await getDesktop()).id }));
  await add("monitors", async () => {
    const screens = await (await getDesktop()).screens();
    return { ok: screens.length > 0, detail: screens.map((s) => `${s.name} ${s.w}x${s.h}+${s.x}+${s.y}`).join("; ") || "none found" };
  });
  await add("windows", async () => ({ ok: true, detail: `${(await (await getDesktop()).listWindows()).length} windows listed` }));
  await add("input injection", async () => (opts.input ? inputCheck() : skip("pass --input to test (it moves the real pointer)")));
  await add("obs", obsCheck);
  await add("demo browser", async () => ({ ok: true, detail: findBrowser() }));
  await add("edge tts", async () => {
    const voices = await withTimeout(getProvider("edge").listVoices(), 10_000, "Edge TTS");
    return { ok: voices.length > 0, detail: `${voices.length} voices` };
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

  const skipped = checks.filter((c) => c.skipped).length;
  const failed = checks.filter((c) => !c.ok).length;
  const ok = checks.length - skipped - failed;
  return { summary: `${ok} ok, ${failed} failed, ${skipped} skipped`, checks };
}
