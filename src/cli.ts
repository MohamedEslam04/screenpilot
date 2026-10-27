#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { analyze } from "./analyze/index.js";
import { evenTimes, grabFrames } from "./frames.js";
import { initStoryboard } from "./init.js";
import { type InputAdapterId, startRecording } from "./record/index.js";
import { remapSession } from "./record/remap.js";
import { Driver } from "./drive/index.js";
import { screenshot } from "./drive/see.js";
import { locate, openBrowser } from "./drive/web.js";
import type { ScreenInfo } from "./record/input/types.js";
import { performTake, TakeError } from "./take/perform.js";
import { takeJsonSchema } from "./take/schema.js";
import { prepareBuild, renderStoryboard, startPreview } from "./render/index.js";
import { lintStoryboard, loadStoryboard, StoryboardError } from "./storyboard/load.js";
import { storyboardJsonSchema } from "./storyboard/schema.js";
import { probeVideo } from "./util/media.js";
import { getProvider } from "./voice/index.js";
import { APP } from "./brand.js";
import { getDesktop } from "./platform/index.js";

const log = (msg: string) => process.stderr.write(`${APP}: ${msg}\n`);
const print = (data: unknown) => process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
async function withDriver(fn: (d: Driver) => Promise<void>): Promise<void> {
  const d = await Driver.open({ log });
  try {
    await fn(d);
  } finally {
    await d.close();
  }
  process.exit(0);
}

/** Monitor layout without opening a remote-control session. */
async function withDriverScreens<T>(fn: (screens: ScreenInfo[]) => Promise<T>): Promise<T> {
  return fn(await (await getDesktop()).screens());
}

const parseMap = (s: string) =>
  Object.fromEntries(
    s.split(",").map((pair) => {
      const i = pair.lastIndexOf("=");
      if (i < 0) throw new Error(`Bad --map entry "${pair}" (want "Source Name=MONITOR")`);
      return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }),
  );
const parseTimes = (s: string) => s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));

const program = new Command()
  .name(APP)
  .description("Record any desktop app, write a storyboard, render a polished demo video.")
  .version("0.1.0");

program
  .command("record")
  .description("Record the screen through OBS and log the pointer; Enter or Ctrl+C stops")
  .option("-d, --dir <dir>", "Session directory (default: sessions/<timestamp>)")
  .option("--input <adapter>", "auto | kwin | uiohook | none", "auto")
  .option("--screen <name>", "Monitor being recorded, e.g. eDP-1 (default: the one under the cursor)")
  .option("--obs-url <url>", "obs-websocket URL (default: from OBS config, else ws://127.0.0.1:4455)")
  .option("--obs-password <pw>", "obs-websocket password (default: from OBS config)")
  .option("--duration <s>", "Stop automatically after this many seconds")
  .option("--screens <list>", 'Record several monitors side by side: "all" or names, e.g. HDMI-A-5,eDP-1')
  .option("--recorder <how>", "native (no OBS: PipeWire on KDE, ffmpeg on Windows) | obs. Default: native when available")
  .option("--map <pairs>", 'OBS source → monitor, e.g. "PC Screen=eDP-1" (remembered)')
  .option("--fit-window <match>", "Resize this window (class or title contains) to 16:9 while recording; restored after")
  .action(
    async (o: {
      dir?: string;
      input: InputAdapterId;
      screen?: string;
      obsUrl?: string;
      obsPassword?: string;
      duration?: string;
      screens?: string;
      map?: string;
      fitWindow?: string;
      recorder?: "native" | "obs";
    }) => {
      const rec = await startRecording({
        ...o,
        screens: o.screens === undefined ? undefined : o.screens === "all" ? "all" : o.screens.split(",").map((x) => x.trim()),
        map: o.map ? parseMap(o.map) : undefined,
        log,
      });
      log(`recording (input: ${rec.inputAdapter}). Press Enter or Ctrl+C to stop.`);
      await new Promise<void>((done) => {
        const finish = () => done();
        process.once("SIGINT", finish);
        if (o.duration) setTimeout(finish, Number(o.duration) * 1000);
        if (process.stdin.isTTY) {
          process.stdin.resume();
          process.stdin.once("data", finish);
        }
      });
      process.stdin.pause();
      const r = await rec.stop();
      for (const w of r.warnings) log(`warning: ${w}`);
      print(r);
    },
  );

program
  .command("remap")
  .description("Re-map pointer events of a session to another monitor (if OBS recorded a different one)")
  .argument("<session>", "Session directory")
  .requiredOption("--screen <name>", "Monitor OBS actually recorded, e.g. HDMI-A-1")
  .action(async (session: string, o: { screen: string }) => {
    print(await remapSession(session, o.screen));
  });

program
  .command("perform")
  .description("The agent performs a take.json on the real desktop while recording; writes a ready storyboard")
  .argument("<take>", "take.json")
  .option("-d, --dir <dir>", "Session directory (default: sessions/<timestamp>)")
  .option("--dry-run", "Drive the desktop without recording (rehearsal)")
  .action(async (takePath: string, o: { dir?: string; dryRun?: boolean }) => {
    let driver: Driver | undefined;
    process.once("SIGINT", () => {
      log("stopping…");
      driver?.abort();
    });
    try {
      print(await performTake(takePath, { ...o, log, onDriver: (d) => (driver = d) }));
      process.exit(0); // the CDP connection to the demo browser would keep us alive
    } catch (err) {
      if (err instanceof TakeError) {
        print({ failedStep: err.index + 1, step: err.step, error: err.cause.message, partial: err.partial });
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command("take-schema")
  .description("Print the take.json JSON Schema")
  .action(() => {
    print(takeJsonSchema());
  });

program
  .command("screenshot")
  .description("Current picture of each monitor (from OBS)")
  .option("--screen <name>", "Only this monitor")
  .option("--grid", "Overlay a 0..1 coordinate grid")
  .option("-w, --width <px>", "Image width", "1280")
  .option("-o, --out <dir>", "Output directory", "screens")
  .action(async (o: { screen?: string; grid?: boolean; width: string; out: string }) => {
    const r = await withDriverScreens((screens) =>
      screenshot(screens, { only: o.screen, grid: o.grid, width: Number(o.width), outDir: o.out }),
    );
    for (const w of r.warnings) log(`warning: ${w}`);
    print(r);
  });

program
  .command("windows")
  .description("List open windows with their position (KWin)")
  .action(async () => {
    print(await (await getDesktop()).listWindows());
  });

program
  .command("browser")
  .description("Open (or reuse) the clean demo browser and place it on a monitor")
  .option("--screen <name>", "Monitor to put it on")
  .option("--url <url>", "Page to open")
  .action(async (o: { screen?: string; url?: string }) => {
    const screens = await withDriverScreens(async (s) => s);
    const screen = o.screen ? screens.find((s) => s.name === o.screen) : undefined;
    print(await openBrowser({ screen, url: o.url, log }));
    process.exit(0);
  });

const drive = program.command("drive").description("Move the pointer, click, type (for testing; takes use perform)");
const target = (s: string) => {
  const [screen, x, y] = s.split(",");
  return { screen: screen || undefined, x: Number(x), y: Number(y) };
};
drive
  .command("move")
  .argument("<target>", "screen,x,y with x/y in 0..1, e.g. eDP-1,0.5,0.5")
  .action(async (t: string) => withDriver((d) => d.moveTo(target(t))));
drive
  .command("click")
  .argument("<target>", "screen,x,y or web:<selector>")
  .option("--button <b>", "left | right | middle", "left")
  .option("--count <n>", "1 = click, 2 = double", "1")
  .action(async (t: string, o: { button: "left" | "right" | "middle"; count: string }) =>
    withDriver(async (d) => {
      if (t.startsWith("web:")) await d.moveToGlobal(await locate(t.slice(4), d));
      else await d.moveTo(target(t));
      await d.click(undefined, { button: o.button, count: Number(o.count) });
    }),
  );
drive
  .command("type")
  .argument("<text>")
  .action(async (text: string) => withDriver((d) => d.type(text)));
drive
  .command("key")
  .argument("<combo>", 'e.g. "ctrl+l"')
  .action(async (combo: string) => withDriver((d) => d.key(combo)));

program
  .command("analyze")
  .description("Find idle time and clicks, suggest cuts and zooms, make a contact sheet")
  .argument("<target>", "Session directory or video")
  .option("--frames <n>", "Thumbnails in the contact sheet", "12")
  .action(async (target: string, o: { frames: string }) => {
    print(await analyze(target, { frames: Number(o.frames) }));
  });

program
  .command("init")
  .description("Write a starter storyboard.json for a recording or session")
  .argument("<target>", "Session directory or raw recording (mp4, mkv, webm, mov)")
  .option("-o, --out <file>", "Storyboard path (default: storyboard.json in the session / next to the video)")
  .option("--voice <name>", "Default Edge TTS voice", "en-US-AndrewNeural")
  .option("--suggest", "Pre-fill segments, zooms and camera views from `analyze`")
  .option("--frame <how>", "Camera for suggested views: window | screen | all", "window")
  .option("-f, --force", "Overwrite an existing storyboard")
  .action(async (target: string, o: { out?: string; voice: string; suggest?: boolean; force?: boolean; frame: "window" | "screen" | "all" }) => {
    print(await initStoryboard(target, o));
  });

program
  .command("validate")
  .description("Check a storyboard against the schema and the source video")
  .argument("<storyboard>")
  .action(async (path: string) => {
    const { sb, baseDir } = await loadStoryboard(path);
    const src = resolve(baseDir, sb.source);
    const warnings = existsSync(src)
      ? lintStoryboard(sb, (await probeVideo(src)).duration)
      : [`source not found: ${src}`];
    print({ valid: true, warnings });
  });

program
  .command("schema")
  .description("Print the storyboard JSON Schema")
  .action(() => {
    print(storyboardJsonSchema());
  });

program
  .command("frames")
  .description("Extract frames (source seconds) so you can see the recording")
  .argument("<video>")
  .option("--at <times>", "Comma-separated seconds, e.g. 1,4.5,10")
  .option("--every <n>", "Instead of --at: this many evenly spaced frames", "12")
  .option("--grid", "Overlay a 0..1 coordinate grid")
  .option("-w, --width <px>", "Frame width", "1280")
  .option("-o, --out <dir>", "Output directory", "frames")
  .action(async (video: string, o: { at?: string; every: string; grid?: boolean; width: string; out: string }) => {
    const info = await probeVideo(video);
    const times = o.at ? parseTimes(o.at) : evenTimes(info.duration, Number(o.every));
    const frames = await grabFrames(video, times, { outDir: o.out, grid: o.grid, width: Number(o.width) });
    print({ duration: info.duration, width: info.width, height: info.height, frames });
  });

program
  .command("voices")
  .description("List available voices")
  .option("--lang <prefix>", "Filter by locale prefix, e.g. ar or en-US")
  .option("--provider <id>", "Voice provider", "edge")
  .action(async (o: { lang?: string; provider: string }) => {
    const voices = await getProvider(o.provider).listVoices();
    print(voices.filter((v) => !o.lang || v.locale.toLowerCase().startsWith(o.lang.toLowerCase())));
  });

program
  .command("build")
  .description("Generate voice, cut the video and write the HyperFrames project without rendering")
  .argument("<storyboard>")
  .option("--build-dir <dir>")
  .action(async (path: string, o: { buildDir?: string }) => {
    const r = await prepareBuild(path, { buildDir: o.buildDir, log });
    print({ buildDir: r.buildDir, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings });
  });

program
  .command("render")
  .description("Render a storyboard to MP4")
  .argument("<storyboard>")
  .option("-o, --output <file>", "Output video (default: <storyboard>.mp4)")
  .option("-q, --quality <q>", "draft | looks | delivery", "looks")
  .option("--png-frames", "Lossless source frames: sharper UI text, slower")
  .option("--workers <n>", "Parallel renderers (each is a headless Chrome)", "2")
  .option("--build-dir <dir>")
  .action(async (path: string, o: { output?: string; quality: "draft" | "looks" | "delivery"; pngFrames?: boolean; buildDir?: string; workers: string }) => {
    const r = await renderStoryboard(path, { ...o, workers: Number(o.workers), log });
    print({ output: r.output, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings });
  });

program
  .command("preview")
  .description("Open the HyperFrames Studio preview for a storyboard")
  .argument("<storyboard>")
  .action(async (path: string) => {
    const r = await prepareBuild(path, { log });
    print(await startPreview(r.buildDir));
  });

program
  .command("check")
  .description("Pull frames from a rendered video to review the result")
  .argument("<video>")
  .option("--at <times>", "Comma-separated output seconds")
  .option("--every <n>", "Evenly spaced frames", "8")
  .option("-o, --out <dir>", "Output directory")
  .action(async (video: string, o: { at?: string; every: string; out?: string }) => {
    const info = await probeVideo(video);
    const times = o.at ? parseTimes(o.at) : evenTimes(info.duration, Number(o.every));
    const outDir = o.out ?? join(dirname(resolve(video)), `${basename(video)}.check`);
    const frames = await grabFrames(video, times, { outDir, width: 960, prefix: "out" });
    print({ duration: info.duration, hasAudio: info.hasAudio, frames });
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof StoryboardError) log(err.message);
  else log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
