#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { analyze } from "./analyze/index.js";
import { doctor } from "./doctor.js";
import { evenTimes, grabFrames } from "./frames.js";
import { initStoryboard } from "./init.js";
import { knownClients, manualConfig, setup } from "./setup/index.js";
import { voiceSetup } from "./setup/voice.js";
import type { LocalModel } from "./voice/local.js";
import { type InputAdapterId, startRecording } from "./record/index.js";
import { remapSession } from "./record/remap.js";
import { Driver } from "./drive/index.js";
import { screenshot } from "./drive/see.js";
import { locate, openBrowser } from "./drive/web.js";
import type { ScreenInfo } from "./record/input/types.js";
import { performTake, TakeError } from "./take/perform.js";
import { takeJsonSchema } from "./take/schema.js";
import { parseFormats } from "./render/formats.js";
import { prepareBuild, renderFormats, renderStoryboard, startPreview } from "./render/index.js";
import { parseWindow } from "./render/window.js";
import { lintStoryboard, loadStoryboard, StoryboardError } from "./storyboard/load.js";
import { storyboardJsonSchema } from "./storyboard/schema.js";
import { renderSequence, validateSequence } from "./sequence/index.js";
import { sequenceJsonSchema } from "./sequence/schema.js";
import { probeVideo } from "./util/media.js";
import { getProvider, voiceMatchesLang } from "./voice/index.js";
import { APP, APP_TITLE, VERSION } from "./brand.js";
import { useBundledTools } from "./bundle.js";
import { getDesktop } from "./platform/index.js";
import { hookPinned } from "./record/input/hook.js";

useBundledTools(import.meta.url);
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
  .description("AI pilot for screen videos: record any app (or let the agent drive it), then edit it into a polished video.")
  .version(VERSION);

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
  .option("--recorder <how>", "native (no OBS: PipeWire on Wayland, ffmpeg on X11, Windows and macOS) | obs. Default: native when available")
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
  .command("setup")
  .description("Install for people who don't use a terminal: copy the app to its folder and add it to every AI tool found (Claude, Codex, OpenCode, Cursor, Gemini, Copilot, Zed, Cline, …)")
  .option("--clients <ids>", "Only these client ids (e.g. claude-desktop,claude-code,codex,opencode,cursor); see `setup --list`")
  .option("--list", "List the AI tools setup knows and whether each is installed here")
  .option("--remove", "Remove it from those tools instead")
  .option("--output <dir>", "Where videos are saved (default: ~/Videos/ScreenPilot)")
  .option("--in-place", "Register the package where it is (no copy)")
  .option("--skip-prepare", "Don't download the render browser or run the test render")
  .option("--allow-tools", "Claude Code: let the agent use every screenpilot tool without asking each time (adds a rule to ~/.claude/settings.json)")
  .option("--print", "Only print the config to paste into an AI tool by hand")
  .action(async (o: { clients?: string; remove?: boolean; output?: string; inPlace?: boolean; skipPrepare?: boolean; allowTools?: boolean; print?: boolean; list?: boolean }) => {
    if (o.list) {
      print(knownClients());
      return;
    }
    if (o.print) {
      print(manualConfig(o.output));
      return;
    }
    const r = await setup({
      clients: o.clients?.split(",").map((x) => x.trim()),
      remove: o.remove,
      outputDir: o.output,
      inPlace: o.inPlace,
      skipPrepare: o.skipPrepare,
      allowTools: o.allowTools,
      log,
    });
    // Dozens of tools are checked: list only the ones that changed (or failed).
    const shown = r.rows.filter((x) => x.status !== "not installed" && x.status !== "not configured");
    const width = Math.max(0, ...shown.map((x) => x.client.length));
    process.stderr.write(`\n${APP_TITLE} ${o.remove ? "removed" : "set up"} (${r.appDir})\n`);
    for (const row of shown) process.stderr.write(`  ${row.client.padEnd(width)}  ${row.status}${row.detail ? `  ${row.detail}` : ""}\n`);
    if (r.renderer) process.stderr.write(`\n  Video renderer: ${r.renderer.ok ? "ready" : `not ready: ${r.renderer.detail}. Videos will download it on first use.`}\n`);
    if (!o.remove) {
      const added = r.rows.filter((x) => x.status === "added").map((x) => x.client);
      const failed = r.rows.filter((x) => x.status === "failed").map((x) => x.client);
      if (added.length) {
        process.stderr.write(`\nDone. Restart ${added.join(", ")}, then ask your AI to record your screen or make a video. Videos are saved to ${r.outputDir}\n`);
      } else if (!failed.length) {
        process.stderr.write("\nNo AI tool found. Install one (Claude Desktop, Codex, OpenCode, Cursor, …) and run setup again.\n");
      }
      if (failed.length) {
        process.stderr.write(`\nCould not add ScreenPilot to ${failed.join(", ")} (see the reason above). Please report it: https://github.com/MohamedEslam04/screenpilot/issues\n`);
        process.exitCode = 1;
      }
    }
    print(r);
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
  .option("--voice <name>", "Default voice: an Edge voice, a local model (voicetut:Sarah, namaa) or a command voice name", "en-US-AndrewNeural")
  .option("--provider <id>", "Voice provider: edge | local | command", "edge")
  .option("--suggest", "Pre-fill segments, zooms and camera views from `analyze`")
  .option("--frame <how>", "Camera for suggested views: window | screen | all", "window")
  .option("-f, --force", "Overwrite an existing storyboard")
  .action(async (target: string, o: { out?: string; voice: string; provider: "edge" | "local" | "command"; suggest?: boolean; force?: boolean; frame: "window" | "screen" | "all" }) => {
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
  .command("voice-setup")
  .description("Install a local voice model in its own Python environment (voice.provider \"local\")")
  .argument("[model]", "voicetut (Egyptian Arabic and English, many voices) or namaa (Egyptian Arabic)", "voicetut")
  .option("--dir <path>", "Where to put the environment and the downloaded models (default: next to the app folder)")
  .option("-y, --yes", "Do not ask before downloading")
  .action(async (model: string, o: { dir?: string; yes?: boolean }) => {
    print(await voiceSetup({ model: model as LocalModel, dir: o.dir, yes: o.yes, log: (line) => console.error(line) }));
  });

program
  .command("voices")
  .description("List available voices")
  .option("--lang <prefix>", "Filter by locale prefix, e.g. ar or en-US")
  .option("--provider <id>", "Voice provider: edge | local | command", "edge")
  .action(async (o: { lang?: string; provider: string }) => {
    const provider = getProvider(o.provider);
    try {
      print((await provider.listVoices()).filter((v) => voiceMatchesLang(v, o.lang)));
    } finally {
      await provider.close?.();
    }
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
  .option("--from <s>", "Render only from this OUTPUT second (fast review; writes <storyboard>.part-<from>-<to>.mp4)", Number)
  .option("--to <s>", "Render only up to this OUTPUT second", Number)
  .option("--formats <list>", "Render once per format, e.g. 16:9,9:16,1:1 or 1280x720 (writes <storyboard>.<format>.mp4)")
  .option("--build-dir <dir>")
  .action(async (path: string, o: { output?: string; quality: "draft" | "looks" | "delivery"; pngFrames?: boolean; buildDir?: string; workers: string; from?: number; to?: number; formats?: string }) => {
    const opts = { ...o, workers: Number(o.workers), window: parseWindow(o.from, o.to), log };
    if (o.formats) {
      if (o.buildDir) throw new Error("--build-dir cannot be combined with --formats (each format gets its own <name>.<format>.build)");
      const rs = await renderFormats(path, parseFormats(o.formats), opts);
      print(rs.map((r) => ({ format: r.format, output: r.output, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings })));
      return;
    }
    const r = await renderStoryboard(path, opts);
    print({ output: r.output, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings });
  });

program
  .command("sequence")
  .description("Render several storyboards (each with its own recording) and join them into one MP4")
  .argument("<sequence>", "sequence.json")
  .option("-o, --output <file>", "Output video (default: <sequence>.mp4)")
  .option("-q, --quality <q>", "draft | looks | delivery", "looks")
  .option("--png-frames", "Lossless source frames: sharper UI text, slower")
  .option("--workers <n>", "Parallel renderers (each is a headless Chrome)", "2")
  .option("--build-dir <dir>")
  .action(async (path: string, o: { output?: string; quality: "draft" | "looks" | "delivery"; pngFrames?: boolean; buildDir?: string; workers: string }) => {
    print(await renderSequence(path, { ...o, workers: Number(o.workers), log }));
  });

program
  .command("sequence-validate")
  .description("Check a sequence.json and every storyboard it uses")
  .argument("<sequence>")
  .action(async (path: string) => {
    print(await validateSequence(path));
  });

program
  .command("sequence-schema")
  .description("Print the sequence.json JSON Schema")
  .action(() => {
    print(sequenceJsonSchema());
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

program
  .command("doctor")
  .description("Check this machine: ffmpeg, desktop, monitors, OBS, demo browser, voices. Prints a JSON report; exit code is always 0")
  .option("--input", "Also test input injection (moves the real pointer for a moment)")
  .action(async (o: { input?: boolean }) => {
    const r = await doctor({ input: o.input });
    print(r);
    log(r.summary);
    process.exit(0);
  });

program
  .parseAsync()
  .then(() => {
    // An idle macOS mouse hook would keep the process alive (see hookPinned).
    if (hookPinned()) process.exit(process.exitCode ?? 0);
  })
  .catch((err: unknown) => {
    if (err instanceof StoryboardError) log(err.message);
    else log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
