#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command, Option } from "commander";
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
import { a11yFindAll, a11yTree } from "./a11y/index.js";
import { parseA11yTarget } from "./a11y/parse.js";
import { performTake, resolveTarget, TakeError } from "./take/perform.js";
import { takeJsonSchema } from "./take/schema.js";
import { parseExtras } from "./render/export.js";
import { parseFormats } from "./render/formats.js";
import { prepareBuild, renderFormats, renderStoryboard, startPreview } from "./render/index.js";
import { parseSubtitleFormats } from "./render/subtitles.js";
import { parseWindow } from "./render/window.js";
import { parseWorkers } from "./render/workers.js";
import { lintStoryboard, loadStoryboard, loadStyle, StoryboardError } from "./storyboard/load.js";
import { qaStoryboard } from "./storyboard/qa.js";
import { storyboardJsonSchema } from "./storyboard/schema.js";
import { estimateSequence } from "./sequence/estimate.js";
import { renderSequence, validateSequence } from "./sequence/index.js";
import { resumePaused } from "./sequence/resume.js";
import { pauseRenders, RenderPaused } from "./render/pause.js";
import { sequenceJsonSchema } from "./sequence/schema.js";
import { probeVideo } from "./util/media.js";
import { describeEstimate, estimateStoryboard } from "./voice/estimate.js";
import { getProvider, voiceMatchesLang } from "./voice/index.js";
import { formatSpend, parseSince, readSpend, summarizeSpend } from "./voice/spend.js";
import { removeSecret, type SecretName, secretSource, secretsFile, setSecret } from "./voice/secrets.js";
import { exportScript, importAudio } from "./voice/import.js";
import { detectBriefEnv } from "./brief/detect.js";
import { applyUpdate, checkForUpdate, sourceFrom, updateCommand } from "./update/index.js";
import { buildBrief, recommendedAnswers, summaryLines } from "./brief/questions.js";
import { APP, APP_TITLE, sessionsRoot, VERSION } from "./brand.js";
import { useBundledTools } from "./bundle.js";
import { getDesktop } from "./platform/index.js";
import { hookPinned } from "./record/input/hook.js";
import { DASHBOARD_BIN_ENV, dashboardBin, dashboardHome, launchDashboard } from "./dashboard/launch.js";
import { importLibrary } from "./history/import.js";
import { readHistory } from "./history/index.js";
import { listJobs } from "./history/jobs.js";

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

const secretNameFor = (provider: string): SecretName => {
  if (provider === "elevenlabs") return "ELEVENLABS_API_KEY";
  if (provider === "gemini") return "GEMINI_API_KEY";
  throw new Error(`Unknown provider "${provider}" (want elevenlabs or gemini)`);
};

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
  .option("-d, --dir <dir>", "Session directory (default: sessions/<timestamp>). One already in use is kept: the take goes to <dir>-2, <dir>-3, ...; <dir>-latest points at the one used")
  .option("--overwrite", "With --dir: move the earlier take to <dir>.prev and reuse <dir>")
  .option("--dry-run", "Drive the desktop without recording (rehearsal)")
  .action(async (takePath: string, o: { dir?: string; overwrite?: boolean; dryRun?: boolean }) => {
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
  .argument("<target>", "screen,x,y, web:<selector> or a11y:<role>:<name> (e.g. a11y:button:Save; a11y::Save = any role)")
  .option("--button <b>", "left | right | middle", "left")
  .option("--count <n>", "1 = click, 2 = double", "1")
  .action(async (t: string, o: { button: "left" | "right" | "middle"; count: string }) =>
    withDriver(async (d) => {
      if (t.startsWith("web:")) await d.moveToGlobal(await locate(t.slice(4), d));
      else if (t.startsWith("a11y:")) await d.moveToGlobal(await resolveTarget({ a11y: parseA11yTarget(t.slice(5)) }, d));
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

const a11y = program.command("a11y").description("Read a native app's UI through the accessibility tree (Linux AT-SPI) and find controls for {a11y} targets");
a11y
  .command("tree")
  .description("Controls of an app with role, name and rectangle in global pixels")
  .option("--app <app>", "Window class or title contains (default: the focused window's app)")
  .option("--all", "Include non-interactive elements")
  .option("--max-depth <n>", "Tree depth", "20")
  .action(async (o: { app?: string; all?: boolean; maxDepth: string }) => {
    const desktop = await getDesktop();
    print(await a11yTree(desktop, { app: o.app, interactiveOnly: !o.all, maxDepth: Number(o.maxDepth) }));
    process.exit(0);
  });
a11y
  .command("find")
  .description("Controls matching a role and/or name")
  .argument("<spec>", "<role>:<name>, e.g. button:Save, or just a name")
  .option("--app <app>", "Window class or title contains (default: the focused window's app)")
  .option("--exact", "Match the whole name")
  .action(async (spec: string, o: { app?: string; exact?: boolean }) => {
    const desktop = await getDesktop();
    print(await a11yFindAll(desktop, { ...parseA11yTarget(spec), app: o.app, exact: o.exact }));
    process.exit(0);
  });

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
  .option("--voice <name>", "Default voice: an Edge voice, a local model (voicetut:Sarah, namaa) a command voice name, an ElevenLabs voice or a Gemini voice (Kore)", "en-US-AndrewNeural")
  .option("--provider <id>", "Voice provider: edge | local | command | elevenlabs | gemini", "edge")
  .option("--suggest", "Pre-fill segments, zooms and camera views from `analyze`")
  .option("--frame <how>", "Camera for suggested views: window | screen | all", "window")
  .option("-f, --force", "Overwrite an existing storyboard")
  .action(async (target: string, o: { out?: string; voice: string; provider: "edge" | "local" | "command" | "elevenlabs" | "gemini"; suggest?: boolean; force?: boolean; frame: "window" | "screen" | "all" }) => {
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
  .command("qa")
  .description("Look at the pixels: flag empty highlights and views that show the desktop (needs ffmpeg)")
  .argument("<storyboard>")
  .action(async (path: string) => {
    const warnings = await qaStoryboard(path);
    print({ ok: warnings.length === 0, warnings });
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
  .option("--provider <id>", "Voice provider: edge | local | command | elevenlabs | gemini", "edge")
  .action(async (o: { lang?: string; provider: string }) => {
    const provider = getProvider(o.provider);
    try {
      print((await provider.listVoices()).filter((v) => voiceMatchesLang(v, o.lang)));
    } finally {
      await provider.close?.();
    }
  });

program
  .command("dashboard")
  .description("Open the dashboard: your recordings, renders, running jobs and voices in one local window (a separate download)")
  .action(() => {
    const bin = dashboardBin();
    if (!bin) {
      throw new Error(
        `The dashboard is not installed. It is a separate program, built from the repository for now (see https://mohamedeslam04.github.io/screenpilot/guide/dashboard.html): put the built screenpilot-dashboard in ${dashboardHome()}, or set ${DASHBOARD_BIN_ENV} to its path.`,
      );
    }
    launchDashboard(bin);
    log(`started ${bin}`);
  });

const secret = program.command("secret").description("API keys for the cloud voices (ElevenLabs, Gemini), kept in secrets.json (mode 0600) in the config folder");
secret
  .command("set")
  .description("Store a key. It is read from stdin, never from an argument, so it stays out of shell history and process lists")
  .argument("<provider>", "elevenlabs | gemini")
  .action(async (provider: string) => {
    const name = secretNameFor(provider);
    if (process.stdin.isTTY) log(`paste the ${provider} key, then press Enter`);
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const key = Buffer.concat(chunks).toString("utf8").trim();
    if (!key) throw new Error("No key on stdin");
    setSecret(name, key);
    print({ provider, stored: true, file: secretsFile() });
  });
secret
  .command("status")
  .description("Which keys are set and where they come from (env or file). Never prints a key")
  .action(() => {
    print(Object.fromEntries(["elevenlabs", "gemini"].map((p) => [p, secretSource(secretNameFor(p))])));
  });
secret
  .command("remove")
  .description("Delete a stored key (an environment variable stays)")
  .argument("<provider>", "elevenlabs | gemini")
  .action((provider: string) => {
    print({ provider, removed: removeSecret(secretNameFor(provider)) });
  });

program
  .command("spend")
  .description("What the cloud voices cost so far: totals of the spend ledger (spend.jsonl in the config folder), by provider. Estimates from your price per credit")
  .option("--since <date>", "Only requests from this day on (YYYY-MM-DD) or time (ISO)")
  .option("--json", "Print the totals and rows as JSON")
  .action(async (o: { since?: string; json?: boolean }) => {
    const since = o.since ? parseSince(o.since) : undefined;
    const rows = await readSpend({ since });
    const summary = summarizeSpend(rows);
    if (o.json) print({ since: since?.toISOString(), ...summary, rows });
    else print(formatSpend(summary, since));
  });

program
  .command("update")
  .description("Update the app files to the latest release without downloading the whole package")
  .option("--check", "Only say whether a newer version exists; change nothing")
  .option("--source <folder|url>", "Read latest.json and the archive from a folder or address instead of GitHub Releases")
  .action(async (o: { check?: boolean; source?: string }) => {
    const source = sourceFrom(o.source);
    if (o.check) print({ ...(await checkForUpdate({ source })), command: updateCommand() });
    else print(await applyUpdate({ source, log }));
  });

program
  .command("brief")
  .description("The decisions to ask the user before recording or building a video (for AI tools that use the CLI instead of MCP)")
  .option("--project <path>", "Folder or storyboard.json of the existing video the recommendations follow (default: this folder)")
  .action(async (o: { project?: string }) => {
    const env = await detectBriefEnv(o.project);
    const brief = buildBrief(env);
    const recommended = recommendedAnswers(brief, {});
    print({
      recommendedSetup: {
        ...(env.suggested?.project ? { basedOn: `${env.suggested.project.file} (${env.suggested.project.summary})` } : {}),
        lines: summaryLines(brief, recommended),
      },
      rules: [
        "Offer the recommended setup first as one question (use it, or choose each item). The recommendation follows the existing video in the folder, then the user's usual choices. The content question is optional.",
        "Ask the user every question below before you record, drive the desktop, build or render. Do not answer for them and do not install anything for them.",
        "Show each choice question as an option picker with your question tool (2 to 4 options, the recommended one first). Ask kind=text questions in chat.",
        "Ask at most 4 questions at once. A question with askWhen is asked only after its parent has one of the listed answers.",
        "Skip a question only when the user already answered it in their request.",
      ],
      questions: brief.questions,
    });
  });

program
  .command("script")
  .description("Write the narration as a script to paste into an external text-to-speech site")
  .argument("<storyboard>")
  .option("-o, --out <file>", "Script file (default: <storyboard>.script.md next to the storyboard)")
  .action(async (path: string, o: { out?: string }) => {
    print(await exportScript(path, o.out));
  });

program
  .command("split-audio")
  .description("Cut one recording of the whole script into a file per narration line (at the pauses) and attach them to the storyboard")
  .argument("<audio>", "Audio file downloaded from the text-to-speech site")
  .option("--storyboard <file>", "Storyboard whose narration lines the audio belongs to; each line's `audio` is set")
  .option("--lines <n>", "Number of lines, when there is no storyboard", Number)
  .option("-o, --out <dir>", "Folder for the per-line files (default: narration-audio next to the storyboard)")
  .option("--min-silence <s>", "Shortest pause that counts as a line break", Number, 0.4)
  .option("--noise <dB>", "Level under which sound counts as silence", Number, -35)
  .action(async (audio: string, o: { storyboard?: string; lines?: number; out?: string; minSilence: number; noise: number }) => {
    print(await importAudio(audio, { storyboard: o.storyboard, lines: o.lines, out: o.out, minSilence: o.minSilence, noiseDb: o.noise }));
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
  .option("--workers <n>", "Parallel renderers, each a headless Chrome: auto (default: half the cores, from free memory), max (idle desktop: all cores but two) or a number. SCREENPILOT_WORKERS sets the default")
  .option("--timings", "Log how long each stage takes and show HyperFrames phase timings")
  .option("--from <s>", "Render only from this OUTPUT second (fast review; writes <storyboard>.part-<from>-<to>.mp4)", Number)
  .option("--to <s>", "Render only up to this OUTPUT second", Number)
  .option("--formats <list>", "Render once per format, e.g. 16:9,9:16,1:1 or 1280x720 (writes <storyboard>.<format>.mp4)")
  .option("--style <file>", "Style file ({ \"theme\": {...} }) merged over the storyboard's theme; writes <storyboard>.<style>.mp4 and keeps its own build folder")
  .option("--subtitles <list>", "Also write subtitle files from the narration: srt, vtt or srt,vtt (next to the video)")
  .option("--also <list>", "Also make files from the finished video: gif, webm, poster (a PNG frame), or a comma list")
  .option("--poster-at <s>", "Time of the poster frame, in OUTPUT seconds (default: a quarter of the way in)", Number)
  .option("--no-chunks", "Render in one piece. By default a video (or --from/--to window) of 5 minutes or more renders in cached chunks cut at quiet points, so after an edit only the touched chunks render again")
  .option("--chunk-seconds <n>", "Length of those chunks (default 180, at least 10)", Number)
  .option("--min-free-mem <MB>", "Before each part or chunk, wait until this much memory is available (default 1500, 0 = off; SCREENPILOT_MIN_FREE_MEM sets the default)", Number)
  .option("--mem-timeout <s>", "Longest wait for that memory, then fail with the numbers (default 300)", Number)
  .option("--build-dir <dir>")
  .option("--dry-run", "Print the lines, characters and estimated USD the voice would cost, then stop: no request, no file, no cache entry")
  .addOption(new Option("--dry").hideHelp())
  .action(async (path: string, o: { output?: string; quality: "draft" | "looks" | "delivery"; pngFrames?: boolean; buildDir?: string; workers?: string; timings?: boolean; from?: number; to?: number; formats?: string; style?: string; subtitles?: string; also?: string; posterAt?: number; chunks: boolean; chunkSeconds?: number; minFreeMem?: number; memTimeout?: number; dryRun?: boolean; dry?: boolean }) => {
    if (o.dryRun || o.dry) {
      const e = await estimateStoryboard(path, { style: o.style ? await loadStyle(o.style) : undefined });
      log(describeEstimate(e));
      print(e);
      return;
    }
    const { subtitles, also, posterAt, style, chunks, minFreeMem, memTimeout, dryRun: _dryRun, dry: _dry, ...rest } = o;
    // Commander sets chunks: true unless --no-chunks; only an explicit "off" is passed on.
    const opts = { ...rest, minFreeMemMB: minFreeMem, memTimeoutS: memTimeout, chunks: chunks ? undefined : false, style: style ? await loadStyle(style) : undefined, workers: parseWorkers(o.workers), window: parseWindow(o.from, o.to), subtitles: parseSubtitleFormats(subtitles), also: parseExtras(also), posterAt, log };
    if (o.formats) {
      if (o.buildDir) throw new Error("--build-dir cannot be combined with --formats (each format gets its own <name>.<format>.build)");
      const rs = await renderFormats(path, parseFormats(o.formats), opts);
      print(rs.map((r) => ({ format: r.format, output: r.output, files: r.files, timeline: r.timelineFile, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings })));
      return;
    }
    const r = await renderStoryboard(path, opts);
    print({ output: r.output, files: r.files, timeline: r.timelineFile, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings });
  });

program
  .command("sequence")
  .description("Render several storyboards (each with its own recording) and join them into one MP4")
  .argument("<sequence>", "sequence.json")
  .option("-o, --output <file>", "Output video (default: <sequence>.mp4)")
  .option("-q, --quality <q>", "draft | looks | delivery", "looks")
  .option("--png-frames", "Lossless source frames: sharper UI text, slower")
  .option("--workers <n>", "Parallel renderers, each a headless Chrome: auto (default: half the cores, from free memory), max (idle desktop: all cores but two) or a number. SCREENPILOT_WORKERS sets the default")
  .option("--timings", "Log how long each stage takes and show HyperFrames phase timings")
  .option("--style <file>", "Style file ({ \"theme\": {...} }) merged over the theme of every part; writes <sequence>.<style>.mp4 and keeps its own build folder")
  .option("--min-free-mem <MB>", "Before each part or chunk, wait until this much memory is available (default 1500, 0 = off; SCREENPILOT_MIN_FREE_MEM sets the default)", Number)
  .option("--mem-timeout <s>", "Longest wait for that memory, then fail with the numbers (default 300)", Number)
  .option("--build-dir <dir>")
  .option("--dry-run", "Print the lines, characters and estimated USD the voices would cost, part by part, then stop: no request, no file, no build folder")
  .addOption(new Option("--dry").hideHelp())
  .action(async (path: string, o: { output?: string; quality: "draft" | "looks" | "delivery"; pngFrames?: boolean; buildDir?: string; workers?: string; timings?: boolean; style?: string; minFreeMem?: number; memTimeout?: number; dryRun?: boolean; dry?: boolean }) => {
    if (o.dryRun || o.dry) {
      const e = await estimateSequence(path, { style: o.style ? await loadStyle(o.style) : undefined });
      log(describeEstimate(e, " (all parts)"));
      print(e);
      return;
    }
    const { style, minFreeMem, memTimeout, dryRun: _dryRun, dry: _dry, ...rest } = o;
    print(await renderSequence(path, { ...rest, minFreeMemMB: minFreeMem, memTimeoutS: memTimeout, style: style ? await loadStyle(style) : undefined, workers: parseWorkers(o.workers), log }));
  });

program
  .command("pause")
  .description("Pause a running render or sequence: it finishes the part (or chunk) in progress, then stops and prints which parts are done. Without a path: every render running now")
  .argument("[path]", "The storyboard or sequence being rendered")
  .option("--build-dir <dir>", "Its build folder, when it is not the default one")
  .action(async (path: string | undefined, o: { buildDir?: string }) => {
    const r = await pauseRenders({ path, buildDir: o.buildDir });
    print(r);
    log("the render stops after the part or chunk in progress; carry on with: screenpilot resume <storyboard or sequence>");
  });

program
  .command("resume")
  .description("Carry on a paused render or sequence with the options it was started with: finished parts and chunks are reused")
  .argument("<path>", "The storyboard or sequence that was paused")
  .option("--build-dir <dir>", "Its build folder, when it is not the default one")
  .option("--workers <n>", "Change the parallel renderers for the rest: auto, max or a number")
  .option("--min-free-mem <MB>", "Before each part or chunk, wait until this much memory is available (default 1500, 0 = off; SCREENPILOT_MIN_FREE_MEM sets the default)", Number)
  .option("--mem-timeout <s>", "Longest wait for that memory, then fail with the numbers (default 300)", Number)
  .action(async (path: string, o: { buildDir?: string; workers?: string; minFreeMem?: number; memTimeout?: number }) => {
    print(await resumePaused(path, { buildDir: o.buildDir, workers: parseWorkers(o.workers, {}), minFreeMemMB: o.minFreeMem, memTimeoutS: o.memTimeout, log }));
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
  .command("history")
  .description("What ScreenPilot recorded and rendered, newest first (JSON). --live lists the renders running now")
  .option("--limit <n>", "How many events", "50")
  .option("--before <iso>", "Only events older than this time (the `at` of the last one of the previous page)")
  .option("--live", "List the renders running now instead")
  .action(async (o: { limit: string; before?: string; live?: boolean }) => {
    print(o.live ? listJobs() : await readHistory({ limit: Number(o.limit), before: o.before }));
  });

const library = program.command("library").description("The history of your work");
library
  .command("import")
  .description("Add recordings and finished renders made before the history existed (two folder levels deep under each root)")
  .option("--root <dir...>", "Folders to look in (default: the sessions folder)")
  .action(async (o: { root?: string[] }) => {
    const r = await importLibrary(o.root?.length ? o.root : [sessionsRoot()]);
    print(r);
    log(`${r.added} added, ${r.total} in the history`);
  });

program
  .parseAsync()
  .then(() => {
    // An idle macOS mouse hook would keep the process alive (see hookPinned).
    if (hookPinned()) process.exit(process.exitCode ?? 0);
  })
  .catch((err: unknown) => {
    // A pause is a clean stop: print where it stopped, exit 0.
    if (err instanceof RenderPaused) {
      print(err.info);
      log(`paused; carry on with: ${err.info.resume}`);
      process.exit(0);
    }
    if (err instanceof StoryboardError) log(err.message);
    else log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
