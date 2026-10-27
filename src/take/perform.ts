import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyze } from "../analyze/index.js";
import { Driver, type DriverAction } from "../drive/index.js";
import { useLatinLayout } from "../drive/keyboard.js";
import { findWindow, focusWindow, listWindows } from "../drive/kwinscript.js";
import { locate, openBrowser, waitForWeb, withPage } from "../drive/web.js";
import { initStoryboard } from "../init.js";
import type { InputEvent } from "../record/events.js";
import { type ActiveRecording, type RecordResult, startRecording } from "../record/index.js";
import type { Rect } from "../record/input/types.js";
import { normalizeEvents } from "../record/normalize.js";
import { synthesizeLines } from "../voice/index.js";
import { type Step, type Take, TakeSchema, type Target } from "./schema.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PerformOptions {
  dir?: string;
  dryRun?: boolean;
  log?: (m: string) => void;
  /** Lets a caller (MCP abort, Ctrl+C) stop the take. */
  onDriver?: (d: Driver) => void;
}

export interface PerformResult {
  dir?: string;
  storyboard?: string;
  recording?: RecordResult;
  steps: { index: number; t: number; kind: string }[];
  warnings: string[];
}

export class TakeError extends Error {
  constructor(
    readonly index: number,
    readonly step: Step,
    override readonly cause: Error,
    readonly partial?: PerformResult,
  ) {
    super(`Step ${index + 1} (${Object.keys(step)[0]}) failed: ${cause.message}`);
  }
}

export async function loadTake(path: string): Promise<Take> {
  const r = TakeSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!r.success) throw new Error(`Invalid take ${path}:\n${r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return r.data;
}

/**
 * Perform a take on the real desktop. Narration is synthesized first so its
 * real length paces the actions: a `say` waits until the previous line has
 * finished, exactly as the final video will play it.
 */
export async function performTake(takePath: string, opts: PerformOptions = {}): Promise<PerformResult> {
  const log = opts.log ?? (() => {});
  const take = await loadTake(takePath);
  const baseDir = dirname(resolve(takePath));

  log("voice: synthesizing lines");
  const says = take.steps.filter((s): s is Extract<Step, { say: string }> => "say" in s);
  const clips = await synthesizeLines(
    "edge",
    says.map((s) => ({ text: s.say, voice: s.voice ?? take.voice.name, rate: take.voice.rate })),
    join(baseDir, ".demoreel-cache", "voice"),
  );
  const lineLength = new Map(says.map((s, i) => [s, clips[i]!.duration]));

  log("opening remote control");
  const driver = await Driver.open({ log });
  opts.onDriver?.(driver);
  const warnings: string[] = [];
  const timeline: { index: number; t: number; kind: string }[] = [];
  const narration: { at: number; text: string; voice?: string }[] = [];
  const captions: { at: number; dur: number; text: string; position: "bottom" | "top" | "center" }[] = [];
  const views: { at: number; screen: string; transition: "pan" }[] = [];
  let rec: ActiveRecording | undefined;
  let t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  let speechFreeAt = 0;

  const ctx: StepContext = { driver, log, baseDir };
  // Before recording: a layout switch later would flash KDE's OSD in the video.
  const restoreLayout = await useLatinLayout();
  try {
    for (const [i, step] of take.setup.entries()) {
      await runStep(step, ctx).catch((e: Error) => {
        throw new TakeError(i, step, e);
      });
    }

    if (!opts.dryRun) {
      log("starting recording");
      rec = await startRecording({ dir: opts.dir, screens: take.screens, input: "kwin", log });
      t0 = rec.startedAt;
    } else {
      t0 = performance.now();
    }
    await sleep(600); // a breath before the first action

    for (const [i, step] of take.steps.entries()) {
      const kind = Object.keys(step)[0]!;
      log(`step ${i + 1}/${take.steps.length}: ${kind}`);
      try {
        if ("say" in step) {
          const free = speechFreeAt + (speechFreeAt ? take.voice.gap : 0);
          if (now() < free) await sleep((free - now()) * 1000);
          const at = now();
          narration.push({ at: round(at), text: step.say, ...(step.voice ? { voice: step.voice } : {}) });
          speechFreeAt = at + lineLength.get(step)!;
          if (step.wait) await sleep((speechFreeAt - now()) * 1000);
        } else if ("caption" in step) {
          captions.push({ at: round(now()), dur: step.dur ?? 3, text: step.caption, position: step.position ?? "bottom" });
        } else if ("view" in step) {
          views.push({ at: round(now()), screen: step.view, transition: "pan" });
        } else {
          await runStep(step, ctx);
        }
        timeline.push({ index: i, t: round(now()), kind });
      } catch (err) {
        throw new TakeError(i, step, err as Error, { steps: timeline, warnings });
      }
    }
    const end = Math.max(now(), speechFreeAt) + take.tail;
    await sleep(Math.max(0, end - now()) * 1000);
  } catch (err) {
    // Keep whatever was recorded so far: it helps to see where it went wrong.
    const partial = rec ? await rec.stop().catch(() => undefined) : undefined;
    await driver.close();
    await restoreLayout();
    if (err instanceof TakeError) {
      throw new TakeError(err.index, err.step, err.cause, { dir: partial?.dir, recording: partial, steps: timeline, warnings });
    }
    throw err;
  }
  await driver.close();

  if (!rec) {
    await restoreLayout();
    return { steps: timeline, warnings };
  }
  const recResult = await rec.stop();
  await restoreLayout();
  warnings.push(...recResult.warnings.filter((w) => !/Clicks not recorded/.test(w)));

  // Clicks come from what the driver did (exact, no input group needed).
  await mergeDriverEvents(recResult, driver.actions, t0);

  const { storyboard } = await initStoryboard(recResult.dir, { voice: take.voice.name, force: true });
  const a = await analyze(recResult.dir);
  const sb = JSON.parse(await readFile(storyboard, "utf8")) as Record<string, unknown>;
  sb.zooms = a.suggestedZooms;
  const hasScreens = Array.isArray(sb.screens) && (sb.screens as unknown[]).length > 0;
  if (views.length && hasScreens) sb.views = views;
  else if (take.camera === "window" && a.suggestedWindowViews?.length) sb.views = a.suggestedWindowViews;
  else if (take.camera !== "all" && hasScreens) sb.views = a.suggestedViews ?? [];
  else sb.views = [];
  sb.narration = narration;
  sb.captions = captions;
  sb.voice = { name: take.voice.name, rate: take.voice.rate, gap: take.voice.gap };
  await writeFile(storyboard, `${JSON.stringify(sb, null, 2)}\n`);
  return { dir: recResult.dir, storyboard, recording: recResult, steps: timeline, warnings };
}

async function mergeDriverEvents(rec: RecordResult, actions: DriverAction[], t0: number): Promise<void> {
  const meta = JSON.parse(await readFile(rec.meta, "utf8")) as { screen: Rect; capture: { contentRect: Rect } };
  const raw = actions
    .filter((a) => a.type === "down" || a.type === "up" || a.type === "scroll")
    .map((a) => ({ at: a.at - t0, type: a.type as "down" | "up" | "scroll", px: a.px, py: a.py, ...(a.button ? { button: a.button } : {}) }));
  const clicks = normalizeEvents(raw, 0, meta.screen, meta.capture.contentRect);
  const path = rec.events ?? join(rec.dir, "events.jsonl");
  let existing: InputEvent[] = [];
  try {
    existing = (await readFile(path, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as InputEvent)
      .filter((e) => e.type === "move");
  } catch {
    // no pointer log
  }
  const all = [...existing, ...clicks].sort((x, y) => x.t - y.t);
  await writeFile(path, all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : ""));
}

interface StepContext {
  driver: Driver;
  log: (m: string) => void;
  baseDir: string;
}

/** Where a take/MCP target is on the desktop (global logical px). */
export async function resolveTarget(t: Target, d: Driver): Promise<{ x: number; y: number }> {
  if ("web" in t) return locate(t.web, d);
  if ("window" in t) {
    const w = findWindow(await listWindows(), t.window);
    if (!w) throw new Error(`No window matching "${t.window}"`);
    return { x: w.x + t.x * w.w, y: w.y + t.y * w.h };
  }
  return d.toGlobal(t);
}

const expandHome = (s: string) => (s.startsWith("~/") ? join(homedir(), s.slice(2)) : s);

async function runStep(step: Step, { driver: d, log, baseDir }: StepContext): Promise<void> {
  if ("browser" in step) {
    const screen = step.browser.screen ? d.screens().find((s) => s.name === step.browser.screen) : undefined;
    await openBrowser({ screen, url: step.browser.url, log });
  } else if ("goto" in step) {
    await withPage((p) => p.goto(step.goto).then(() => undefined));
  } else if ("move" in step) {
    await d.moveToGlobal(await resolveTarget(step.move, d), { dur: step.dur });
  } else if ("click" in step) {
    await d.moveToGlobal(await resolveTarget(step.click, d));
    await sleep(120);
    await d.click(undefined, { button: step.button, count: step.count });
  } else if ("drag" in step) {
    const from = await resolveTarget(step.drag.from, d);
    const to = await resolveTarget(step.drag.to, d);
    await d.moveToGlobal(from);
    await d.dragTo(to, { dur: step.dur });
  } else if ("type" in step) {
    const text = typeof step.type === "string" ? step.type : process.env[step.type.env];
    if (text === undefined) throw new Error(`env var ${typeof step.type === "string" ? "" : step.type.env} is not set`);
    await d.type(text, { cps: step.cps });
  } else if ("key" in step) {
    await d.key(step.key);
  } else if ("scroll" in step) {
    if (step.at) await d.moveToGlobal(await resolveTarget(step.at, d));
    await d.scroll(step.scroll, { horizontal: step.horizontal });
  } else if ("wait" in step && typeof step.wait === "number") {
    // (a `say` step also has an optional boolean `wait`; it never reaches here)
    await sleep(step.wait * 1000);
  } else if ("waitFor" in step) {
    await waitForWeb(step.waitFor.web, (step.waitFor.timeout ?? 30) * 1000);
  } else if ("waitForWindow" in step) {
    const deadline = Date.now() + (step.waitForWindow.timeout ?? 15) * 1000;
    while (!findWindow(await listWindows(), step.waitForWindow.match)) {
      if (Date.now() > deadline) throw new Error(`No window matching "${step.waitForWindow.match}" appeared`);
      await sleep(300);
    }
  } else if ("focus" in step) {
    const w = findWindow(await listWindows(), step.focus.match);
    if (!w) throw new Error(`No window matching "${step.focus.match}"`);
    const s = step.focus.screen ? d.screens().find((x) => x.name === step.focus.screen) : undefined;
    await focusWindow(w.id, s ? { screen: s.name } : undefined);
    await sleep(350);
  } else if ("run" in step) {
    const [cmd, ...args] = step.run.map(expandHome);
    log(`run: ${cmd}`);
    spawn(cmd!, args, { cwd: baseDir, detached: true, stdio: "ignore" }).unref();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
