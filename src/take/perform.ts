import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { a11yFind, a11yWait, launchEnv } from "../a11y/index.js";
import { analyze } from "../analyze/index.js";
import { resolveTypeMethod } from "../drive/clipboard.js";
import { Driver, type DriverAction } from "../drive/index.js";
import { describeError, type Disposition, TargetError } from "../drive/errors.js";
import { findWindow } from "../platform/index.js";
import { demoBrowser, MAIN_BROWSER } from "../drive/web.js";
import { initStoryboard } from "../init.js";
import type { InputEvent } from "../record/events.js";
import { type ActiveRecording, type RecordResult, startRecording } from "../record/index.js";
import type { Rect } from "../record/input/types.js";
import type { WindowInfo } from "../platform/types.js";
import { normalizeEvents } from "../record/normalize.js";
import { lineDurations } from "../voice/index.js";
import { openWithDefaultApp } from "./open.js";
import { type Step, type Take, TakeSchema, type Target } from "./schema.js";
import { runCommand } from "./run.js";
import type { Typing } from "../storyboard/schema.js";
import { prepareSessionDir } from "./session-dir.js";
import { boundingRect, tiledView, tileRects, tileTarget } from "./tile.js";
import { type Tracked, trackedHighlights, trackElement } from "./track.js";
import { typingSpan } from "./typing.js";
import { windowMatches } from "./windows.js";
import { CACHE_DIR } from "../brand.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PerformOptions {
  /** Session directory. A used one is never overwritten: the take goes to `<dir>-2`, `<dir>-3`, ... (the result's `dir` says which). */
  dir?: string;
  /** With `dir`: move a previous take there to `<dir>.prev` and reuse `dir`, instead of versioning the name. */
  overwrite?: boolean;
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
  /** Error code and what is safe to do next, when the cause carries them (target errors do). */
  readonly info: (Disposition & { code?: string; candidates?: string[] }) | undefined;
  constructor(
    readonly index: number,
    readonly step: Step,
    override readonly cause: Error,
    readonly partial?: PerformResult,
  ) {
    super(`Step ${index + 1} (${Object.keys(step)[0]}) failed: ${cause.message}`);
    this.info = describeError(cause);
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

  log(opts.dryRun ? "voice: dry run, line lengths estimated" : "voice: synthesizing lines");
  const says = take.steps.filter((s): s is Extract<Step, { say: string }> => "say" in s);
  const lengths = await lineDurations(
    take.voice.provider,
    says.map((s) => ({ text: s.say, voice: s.voice ?? take.voice.name, rate: take.voice.rate })),
    join(baseDir, CACHE_DIR, "voice"),
    opts.dryRun,
  );
  const lineLength = new Map(says.map((s, i) => [s, lengths[i]!]));

  log("opening remote control");
  const driver = await Driver.open({ log });
  opts.onDriver?.(driver);
  const warnings: string[] = [];
  const timeline: { index: number; t: number; kind: string }[] = [];
  const narration: { at: number; text: string; voice?: string }[] = [];
  const captions: { at: number; dur: number; text: string; position: "bottom" | "top" | "center" }[] = [];
  const views: { at: number; screen: string; transition: "pan" }[] = [];
  const typings: Typing[] = [];
  let rec: ActiveRecording | undefined;
  let t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  let speechFreeAt = 0;
  let tracked: Tracked[] = [];

  const ctx: StepContext = {
    driver,
    log,
    baseDir,
    lastWebBrowser: undefined,
    browsers: new Set(),
    now,
    recording: false,
    tracks: [],
    untilNext: [],
    stopTracks: new AbortController(),
    warn: (m) => {
      log(m);
      warnings.push(m);
    },
  };
  // Before recording: a layout switch later would flash KDE's OSD in the video.
  const restoreLayout = await driver.desktop.useLatinLayout();
  try {
    for (const [i, step] of take.setup.entries()) {
      await runStep(step, ctx).catch((e: Error) => {
        throw new TakeError(i, step, e);
      });
    }

    if (!opts.dryRun) {
      log("starting recording");
      const dir = opts.dir ? await prepareSessionDir(opts.dir, { overwrite: opts.overwrite }) : undefined;
      if (dir && dir !== resolve(opts.dir!)) log(`${opts.dir} is in use, recording to ${dir}`);
      rec = await startRecording({ dir, screens: take.screens, input: "auto", log });
      t0 = rec.startedAt;
      ctx.recording = true;
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
          stopUntilNext(ctx);
          narration.push({ at: round(at), text: step.say, ...(step.voice ? { voice: step.voice } : {}) });
          speechFreeAt = at + lineLength.get(step)!;
          if (step.wait) await sleep((speechFreeAt - now()) * 1000);
        } else if ("caption" in step) {
          captions.push({ at: round(now()), dur: step.dur ?? 3, text: step.caption, position: step.position ?? "bottom" });
        } else if ("view" in step) {
          views.push({ at: round(now()), screen: step.view, transition: "pan" });
        } else {
          const started = now();
          await runStep(step, ctx);
          if ("type" in step) typings.push(typingSpan(step, started, now()));
        }
        timeline.push({ index: i, t: round(now()), kind });
      } catch (err) {
        throw new TakeError(i, step, err as Error, { steps: timeline, warnings });
      }
    }
    const end = Math.max(now(), speechFreeAt) + take.tail;
    await sleep(Math.max(0, end - now()) * 1000);
    ctx.stopTracks.abort();
    tracked = await Promise.all(ctx.tracks);
    // Several browsers: the camera holds on all of them (the tiled area, else around their windows).
    if (rec && ctx.browsers.size > 1) ctx.tiledArea ??= await browsersArea([...ctx.browsers], ctx.warn);
  } catch (err) {
    ctx.stopTracks.abort();
    await Promise.allSettled(ctx.tracks);
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
  const meta = JSON.parse(await readFile(recResult.meta, "utf8")) as { screen: Rect; capture: { contentRect: Rect } };
  if (views.length && hasScreens) sb.views = views;
  else if (ctx.browsers.size > 1 && ctx.tiledArea && take.camera !== "all") {
    sb.views = [tiledView(ctx.tiledArea, meta.screen, meta.capture.contentRect, [...ctx.browsers])];
  } else if (take.camera === "window" && a.suggestedWindowViews?.length) sb.views = a.suggestedWindowViews;
  else if (take.camera !== "all" && hasScreens) sb.views = a.suggestedViews ?? [];
  else sb.views = [];
  sb.narration = narration;
  sb.captions = captions;
  // Where the take typed (a secret is timed, never copied): mark them so sounds.typing can play on them.
  if (typings.length) sb.typing = typings;
  if (tracked.length) {
    const hl = trackedHighlights(tracked, meta.screen, meta.capture.contentRect);
    warnings.push(...hl.warnings);
    if (hl.highlights.length) sb.highlights = [...(Array.isArray(sb.highlights) ? sb.highlights : []), ...hl.highlights];
  }
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
  /** The demo browser of the last pointer target, if it was a {web} one: typed text and keys must reach it too. */
  lastWebBrowser: string | undefined;
  /** Every demo browser id the take used; 2+ make the storyboard hold one view on all of them. */
  browsers: Set<string>;
  /** Global px area the last tile step filled. */
  tiledArea?: Rect;
  /** Seconds since the recording started (the storyboard's source time). */
  now: () => number;
  /** False for setup steps and dry runs: highlight steps then only check their selector. */
  recording: boolean;
  /** Background highlight tracks, awaited before the storyboard is written. */
  tracks: Promise<Tracked>[];
  /** Tracks with until: "next", stopped by the next say or highlight step. */
  untilNext: AbortController[];
  /** Stops every track at the end of the take. */
  stopTracks: AbortController;
  /** A warning for the take's result. */
  warn: (m: string) => void;
}

function stopUntilNext(ctx: StepContext): void {
  for (const c of ctx.untilNext.splice(0)) c.abort();
}

/**
 * A highlight step: checks the selector now (fails the step on a bad selector), then follows the
 * element in the background while later steps run. Outside a recording it only checks.
 */
async function startHighlight(h: Extract<Step, { highlight: unknown }>["highlight"], ctx: StepContext): Promise<void> {
  stopUntilNext(ctx);
  // With the pointer: calibrates the window once if no web target did yet, so background samples never move it.
  const b = demoBrowser(h.browser ?? MAIN_BROWSER);
  const first = await b.measure(h.web, ctx.driver);
  if (!ctx.recording) {
    if (!first) ctx.warn(`highlight "${h.web}": not visible at this point of the dry run (it may appear later)`);
    return;
  }
  let signal = ctx.stopTracks.signal;
  if (h.until === "next") {
    const next = new AbortController();
    ctx.untilNext.push(next);
    signal = AbortSignal.any([next.signal, signal]);
  }
  const span = trackElement(h.web, { startedAt: ctx.now(), max: h.dur ?? 8, signal, now: ctx.now, browser: b.id });
  ctx.tracks.push(span.then((s) => ({ selector: h.web, ...(h.label ? { label: h.label } : {}), span: s })));
}

/** Where a take/MCP target is on the desktop (global logical px). */
export async function resolveTarget(t: Target, d: Driver, opts: { force?: boolean } = {}): Promise<{ x: number; y: number }> {
  if ("a11y" in t) {
    const m = await a11yFind(d.desktop, t.a11y);
    return { x: m.cx, y: m.cy };
  }
  if ("web" in t) return demoBrowser(t.browser ?? MAIN_BROWSER).locate(t.web, d, undefined, opts);
  if ("window" in t) {
    const windows = await d.desktop.listWindows();
    const w = pickWindow(windows, t.window);
    if (!w) throw windowNotFound(windows, t.window);
    return { x: w.x + t.x * w.w, y: w.y + t.y * w.h };
  }
  return d.toGlobal(t);
}

/** The window a match refers to: of several, the focused one wins, else the first. */
export function pickWindow(windows: WindowInfo[], match: string): WindowInfo | undefined {
  const hits = windowMatches(windows, match);
  return hits.find((w) => w.active) ?? hits[0];
}

/** "No window matching": says what windows there are, so the next try can match. */
export function windowNotFound(windows: WindowInfo[], match: string): TargetError {
  const have = windows.slice(0, 10).map((w) => `${w.resourceClass} "${w.caption.slice(0, 50)}"`);
  return new TargetError("WINDOW_NOT_FOUND", `No window matching "${match}"${have.length ? `. Open windows: ${have.join("; ")}` : " (this desktop lists no windows)"}`, have);
}

const expandHome = (s: string) => (s.startsWith("~/") ? join(homedir(), s.slice(2)) : s);

/** A URL as is; a file path (relative to the take, or ~/…) as a file:// URL, so takes work from any checkout. */
export function pageUrl(u: string, baseDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) return u;
  return pathToFileURL(resolve(baseDir, expandHome(u))).href;
}

/**
 * Playwright drives a demo browser whatever window is in front, but the real
 * pointer and keys go to the front window: bring that demo browser up first.
 */
export async function ensureDemoBrowserActive(d: Driver, log: (m: string) => void, id = MAIN_BROWSER): Promise<void> {
  const win = await demoBrowser(id).window();
  if (win.active) return;
  await d.desktop.focusWindow(win.id);
  await sleep(350);
  log(`web target: brought the demo browser${id === MAIN_BROWSER ? "" : ` "${id}"`} to the front`);
}

/** The demo browser a target is in, or undefined for a non-web target. */
const webBrowserOf = (t: Target): string | undefined => ("web" in t ? (t.browser ?? MAIN_BROWSER) : undefined);

/** Every demo browser id a step uses (its targets, browser, goto, waitFor, highlight, focus, tile). */
export function stepBrowsers(step: Step): string[] {
  const ids: (string | undefined)[] = [];
  // A goto step may carry `browser: "<id>"` too, so it is told apart first.
  if ("goto" in step) ids.push(step.browser ?? MAIN_BROWSER);
  else if ("browser" in step) ids.push(step.browser.id ?? MAIN_BROWSER);
  if ("move" in step) ids.push(webBrowserOf(step.move));
  if ("click" in step) ids.push(webBrowserOf(step.click));
  if ("drag" in step) ids.push(webBrowserOf(step.drag.from), webBrowserOf(step.drag.to));
  if ("scroll" in step && step.at) ids.push(webBrowserOf(step.at));
  if ("waitFor" in step && "web" in step.waitFor) ids.push(step.waitFor.browser ?? MAIN_BROWSER);
  if ("highlight" in step) ids.push(step.highlight.browser ?? MAIN_BROWSER);
  if ("focus" in step && step.focus.browser !== undefined) ids.push(step.focus.browser === true ? MAIN_BROWSER : step.focus.browser);
  if ("tile" in step) ids.push(...step.tile.browsers);
  return [...new Set(ids.filter((id): id is string => id !== undefined))];
}

/** The area around every listed demo browser's window (global px), or undefined (with a warning) when one cannot be found. */
async function browsersArea(ids: string[], warn: (m: string) => void): Promise<Rect | undefined> {
  try {
    return boundingRect(await Promise.all(ids.map((id) => demoBrowser(id).window())));
  } catch (e) {
    warn(`browsers ${ids.join(", ")}: no window area for the camera (${(e as Error).message}); views follow windows instead`);
    return undefined;
  }
}

/** Places the listed demo browsers side by side on a monitor (see the tile step). */
async function tileBrowsers(t: Extract<Step, { tile: unknown }>["tile"], ctx: StepContext): Promise<void> {
  const { driver: d } = ctx;
  const wins: WindowInfo[] = [];
  for (const id of t.browsers) {
    wins.push(
      await demoBrowser(id)
        .window()
        .catch((e: Error) => {
          throw new Error(`tile: the demo browser "${id}" is not open (add a browser step with id "${id}" first): ${e.message}`);
        }),
    );
  }
  const name = t.screen ?? wins[0]!.output;
  const screen = d.screens().find((s) => s.name === name);
  if (!screen) throw new Error(`tile: unknown monitor "${name}" (have: ${d.screens().map((s) => s.name).join(", ")})`);
  const area = await tileTarget(d.desktop, screen, ctx.warn);
  const rects = tileRects(area, wins.length);
  for (const [i, w] of wins.entries()) {
    await d.desktop.focusWindow(w.id, rects[i]);
    demoBrowser(t.browsers[i]!).forgetWindow();
  }
  await sleep(400);
  ctx.tiledArea = area;
}

async function runStep(step: Step, ctx: StepContext): Promise<void> {
  const { driver: d, log, baseDir } = ctx;
  for (const id of stepBrowsers(step)) ctx.browsers.add(id);
  // Pointer targets: a {web} one needs its demo browser in front; remember it for the keys that follow.
  const pointer = "move" in step ? [step.move] : "click" in step ? [step.click] : "drag" in step ? [step.drag.from, step.drag.to] : "scroll" in step && step.at ? [step.at] : [];
  if (pointer.length) {
    ctx.lastWebBrowser = pointer.map(webBrowserOf).find((id) => id !== undefined);
    if (ctx.lastWebBrowser) await ensureDemoBrowserActive(d, log, ctx.lastWebBrowser);
  } else if (("type" in step || "key" in step) && ctx.lastWebBrowser) {
    await ensureDemoBrowserActive(d, log, ctx.lastWebBrowser);
  }
  // goto first: a goto step may carry `browser: "<id>"` too.
  if ("goto" in step) {
    await demoBrowser(step.browser ?? MAIN_BROWSER).withPage((p) => p.goto(pageUrl(step.goto, baseDir)).then(() => undefined));
  } else if ("browser" in step) {
    const screen = step.browser.screen ? d.screens().find((s) => s.name === step.browser.screen) : undefined;
    await demoBrowser(step.browser.id ?? MAIN_BROWSER).open({ screen, url: step.browser.url && pageUrl(step.browser.url, baseDir), app: step.browser.app, log });
  } else if ("move" in step) {
    await d.moveToGlobal(await resolveTarget(step.move, d), { dur: step.dur });
  } else if ("click" in step) {
    await d.moveToGlobal(await resolveTarget(step.click, d, { force: step.force }));
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
    if (resolveTypeMethod(step.method, text) === "paste") await d.paste(text, { secret: typeof step.type !== "string" });
    else await d.type(text, { cps: step.cps });
  } else if ("key" in step) {
    await d.key(step.key);
  } else if ("scroll" in step) {
    if (step.at) await d.moveToGlobal(await resolveTarget(step.at, d));
    await d.scroll(step.scroll, { horizontal: step.horizontal });
  } else if ("wait" in step && typeof step.wait === "number") {
    // (a `say` step also has an optional boolean `wait`; it never reaches here)
    await sleep(step.wait * 1000);
  } else if ("waitFor" in step) {
    if ("a11y" in step.waitFor) await a11yWait(d.desktop, step.waitFor.a11y, (step.waitFor.timeout ?? 30) * 1000);
    else await demoBrowser(step.waitFor.browser ?? MAIN_BROWSER).waitFor(step.waitFor.web, (step.waitFor.timeout ?? 30) * 1000);
  } else if ("waitForWindow" in step) {
    const deadline = Date.now() + (step.waitForWindow.timeout ?? 15) * 1000;
    while (!findWindow(await d.desktop.listWindows(), step.waitForWindow.match)) {
      if (Date.now() > deadline) throw new Error(`No window matching "${step.waitForWindow.match}" appeared`);
      await sleep(300);
    }
  } else if ("focus" in step) {
    const windows = await d.desktop.listWindows();
    let w: WindowInfo | undefined;
    const focusBrowser = step.focus.browser === undefined ? undefined : step.focus.browser === true ? MAIN_BROWSER : step.focus.browser;
    if (focusBrowser !== undefined) {
      w = await demoBrowser(focusBrowser).window();
    } else if (step.focus.match !== undefined) {
      const hits = windowMatches(windows, step.focus.match);
      w = pickWindow(windows, step.focus.match);
      if (!w) throw windowNotFound(windows, step.focus.match);
      if (hits.length > 1) {
        log(`focus: ${hits.length} windows match "${step.focus.match}"; using ${w.resourceClass} "${w.caption}" pid ${w.pid}; use {browser: true} for the demo browser`);
      }
    }
    if (!w) throw new Error("focus: give match or browser");
    const s = step.focus.screen ? d.screens().find((x) => x.name === step.focus.screen) : undefined;
    await d.desktop.focusWindow(w.id, s ? { screen: s.name } : undefined);
    if (focusBrowser !== undefined && s) demoBrowser(focusBrowser).forgetWindow();
    ctx.lastWebBrowser = focusBrowser;
    await sleep(350);
  } else if ("open" in step) {
    const target = /^[a-z][a-z0-9+.-]+:\/\//i.test(step.open) ? step.open : resolve(baseDir, expandHome(step.open));
    log(`open: ${target}`);
    openWithDefaultApp(target, launchEnv());
  } else if ("highlight" in step) {
    await startHighlight(step.highlight, ctx);
  } else if ("tile" in step) {
    await tileBrowsers(step.tile, ctx);
  } else if ("run" in step) {
    const [cmd, ...args] = step.run.map(expandHome);
    log(`run: ${cmd}${step.wait ? " (waiting for exit)" : ""}`);
    await runCommand([cmd!, ...args], {
      cwd: baseDir,
      wait: step.wait === true,
      timeoutMs: (step.timeout ?? 30) * 1000,
      env: launchEnv(),
    });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
