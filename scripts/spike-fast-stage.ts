// Spike (plan 2026-11-08-fast-stage-renderer, Task 1): can the recording layer skip Chrome?
//   tsx scripts/spike-fast-stage.ts <work-dir> <step...>
// Steps: prep, ref, camera, backdrop, stage, overlay, compose, measure, restyle, all.
// <work-dir> must hold src.mp4 and sb.json (the benchmark storyboard). Results go to <work-dir>/results.json.
// CPU only (ffmpeg, HyperFrames, one headless Chrome for the backdrop); it never touches the desktop.
// Not shipped: the numbers decide whether Tasks 2-8 happen.
//
// Result on the dev machine (2026-11-08, 40 s 1080p30, delivery, 4 workers, 1-min load <= 3): NO-GO on speed.
// Parity passed (SSIM whole mean 0.9954, min 0.9926; camera within 0.09 px of GSAP), but
// Chrome 43.3 s cold / 31.5-32.4 s warm extract cache; fast = backdrop 0.4 + stage 16.5 + overlay 12.7
// + composite 15.6 s (the delivery x264 encode alone is 15.8 s); restyle (overlay + composite) 30.0 s.
// Gotchas found: perspective's `on` starts at 1; Matroska stores ms timestamps, so the composite must
// renumber frames in a 1/fps time base or overlay frames pair with the previous stage frame.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { hyperframesBin, hyperframesEnv, prepareBuild } from "../src/render/index.js";
import type { RenderPlan } from "../src/render/plan.js";
import type { CamTween } from "../src/render/zoom.js";

const [workArg, ...stepArgs] = process.argv.slice(2);
if (!workArg) throw new Error("usage: spike-fast-stage.ts <work-dir> <step...>");
const WORK = resolve(workArg);
const steps = new Set(stepArgs.includes("all") ? ["prep", "ref", "camera", "backdrop", "stage", "overlay", "compose", "measure", "restyle"] : stepArgs);
const REPEATS = Number(process.env.SPIKE_REPEATS ?? 3);
const WORKERS = 4;
const log = (m: string) => process.stderr.write(`spike: ${m}\n`);

const P = {
  sb: join(WORK, "sb.json"),
  build: join(WORK, "sb.build"),
  ref: join(WORK, "ref.mp4"),
  backdrop: join(WORK, "backdrop.png"),
  mask: join(WORK, "mask.png"),
  stage: join(WORK, "stage.mkv"),
  ovlBuild: join(WORK, "ovl.build"),
  ovlOut: join(WORK, "ovl.frames"),
  fast: join(WORK, "fast.mp4"),
  restyleSb: join(WORK, "restyle.json"),
  restyleBuild: join(WORK, "restyle.build"),
  restyleOvlBuild: join(WORK, "restyle-ovl.build"),
  restyleOvlOut: join(WORK, "restyle-ovl.frames"),
  restyleFast: join(WORK, "restyle-fast.mp4"),
  results: join(WORK, "results.json"),
};

type Results = Record<string, unknown>;
const results: Results = existsSync(P.results) ? JSON.parse(readFileSync(P.results, "utf8")) : {};
const save = () => writeFile(P.results, JSON.stringify(results, null, 2));

// --- process helpers ---

function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok(out + err) : fail(new Error(`${cmd} ${args.slice(0, 6).join(" ")} ... exited ${code}\n${err.slice(-3000)}`))));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait (up to 5 min) until the 1-minute load is at most 3; returns the load at start. */
async function quiet(): Promise<number> {
  for (let i = 0; i < 15; i++) {
    const l = loadavg()[0]!;
    if (l <= 3) return round2(l);
    log(`load ${l.toFixed(2)} > 3, waiting 20 s`);
    await sleep(20_000);
  }
  const l = loadavg()[0]!;
  log(`load still ${l.toFixed(2)} after 5 min; timing anyway`);
  return round2(l);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Run `fn` `n` times under quiet(), return median wall seconds plus each run with its load. */
async function timed(name: string, n: number, fn: () => Promise<unknown>): Promise<{ median: number; runs: { s: number; load: number }[] }> {
  const runs: { s: number; load: number }[] = [];
  for (let i = 0; i < n; i++) {
    const load = await quiet();
    const t0 = performance.now();
    await fn();
    const s = round2((performance.now() - t0) / 1000);
    runs.push({ s, load });
    log(`${name} run ${i + 1}/${n}: ${s} s (load ${load})`);
  }
  const r = { median: median(runs.map((r) => r.s)), runs };
  results[`time.${name}`] = r;
  await save();
  return r;
}

const hf = (args: string[]) => sh(process.execPath, [hyperframesBin(), ...args], { env: hyperframesEnv() });

// --- the plan ---

async function loadPlan(build: string): Promise<RenderPlan> {
  return JSON.parse(await readFile(join(build, "plan.json"), "utf8")).plan as RenderPlan;
}

// --- camera: a pure re-implementation of the GSAP timeline html.ts emits ---

interface Cam {
  x: number;
  y: number;
  scale: number;
}

/** power2.inOut in GSAP = cubic in-out. */
const ease = (p: number) => (p < 0.5 ? Math.pow(p * 2, 3) / 2 : 1 - Math.pow((1 - p) * 2, 3) / 2);

/**
 * #cam state at output time t. Tweens are `tl.to` (start value = the state when the tween
 * starts) or `tl.set` (dur 0). A later-starting tween overrides an earlier one still running.
 */
export function cameraAt(camera: CamTween[], t: number): Cam {
  const order = camera.map((c, i) => ({ c, i })).sort((a, b) => a.c.t - b.c.t || a.i - b.i);
  const at = (time: number, upto: number): Cam => {
    let s: Cam = { x: 0, y: 0, scale: 1 };
    for (let k = 0; k < upto; k++) {
      const { c } = order[k]!;
      if (c.t > time) break;
      if (c.dur === 0) {
        s = { x: c.x, y: c.y, scale: c.scale };
        continue;
      }
      const from = at(c.t, k);
      const e = ease(Math.min(1, (time - c.t) / c.dur));
      s = { x: from.x + (c.x - from.x) * e, y: from.y + (c.y - from.y) * e, scale: from.scale + (c.scale - from.scale) * e };
    }
    return s;
  };
  return at(t, order.length);
}

/** Piecewise ffmpeg expression of T (seconds) for one camera property, mirroring cameraAt. */
function cameraExpr(camera: CamTween[], prop: keyof Cam): string {
  const order = [...camera].sort((a, b) => a.t - b.t);
  // From each tween's start state (computed once, in JS) to its target.
  const pieces: { t0: number; t1: number; from: number; to: number; dur: number }[] = [];
  for (const c of order) {
    const from = cameraAt(camera, c.t - 1e-9)[prop];
    pieces.push({ t0: c.t, t1: c.t + c.dur, from: c.dur === 0 ? c[prop] : from, to: c[prop], dur: c.dur });
  }
  const easeE = (p: string) => `if(lt(${p},0.5),pow(2*${p},3)/2,1-pow(2-2*${p},3)/2)`;
  // The latest piece that has started decides, so it is the outermost test.
  let expr = String(prop === "scale" ? 1 : 0);
  for (let k = 0; k < pieces.length; k++) {
    const pc = pieces[k]!;
    const body =
      pc.dur === 0
        ? `${pc.to}`
        : `if(gte(T,${pc.t1}),${pc.to},${pc.from}+(${pc.to - pc.from})*${easeE(`((T-${pc.t0})/${pc.dur})`)})`;
    expr = `if(gte(T,${pc.t0}),${body},${expr})`;
  }
  return expr;
}

// --- steps ---

async function prep() {
  log("prepare (voice, cut, composition)");
  await prepareBuild(P.sb, { buildDir: P.build, log });
}

async function ref() {
  const t = await timed("chrome-ref", 1, () =>
    hf(["render", P.build, "-o", P.ref, "-q", "delivery", "--video-frame-format", "auto", "--workers", String(WORKERS), "--quiet"]),
  );
  log(`chrome reference: ${t.median} s`);
}

function chromePath(): string {
  const base = join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  const ver = readdirSync(base).sort().at(-1)!;
  return join(base, ver, "chrome-headless-shell-linux64", "chrome-headless-shell");
}

/** GSAP's own #cam transform at every output frame, read from the real composition. */
async function camera() {
  const plan = await loadPlan(P.build);
  const browser = await chromium.launch({ executablePath: chromePath() });
  try {
    const page = await browser.newPage({ viewport: { width: plan.width, height: plan.height } });
    // No fonts or video needed: only the timeline.
    await page.route(/fonts\.googleapis|\.mp4$/, (r) => r.abort());
    await page.goto(`file://${join(P.build, "index.html")}`, { waitUntil: "domcontentloaded" });
    const frames = Math.round(plan.duration * plan.fps);
    const truth: Cam[] = await page.evaluate(
      ({ frames, fps }) => {
        const tl = (window as unknown as { __timelines: Record<string, { seek: (t: number, s?: boolean) => void }> }).__timelines.main!;
        const cam = document.getElementById("cam")!;
        const out: { x: number; y: number; scale: number }[] = [];
        for (let i = 0; i < frames; i++) {
          tl.seek(i / fps, false);
          const m = new DOMMatrix(getComputedStyle(cam).transform === "none" ? undefined : getComputedStyle(cam).transform);
          out.push({ x: m.e, y: m.f, scale: m.a });
        }
        return out;
      },
      { frames, fps: plan.fps },
    );
    // Error in output pixels: where each frame corner lands in the recording, ours vs GSAP's, times the zoom.
    let worst = { px: 0, frame: -1, t: 0 };
    const corners = [
      [0, 0],
      [plan.frame.w, 0],
      [0, plan.frame.h],
      [plan.frame.w, plan.frame.h],
    ];
    for (let i = 0; i < frames; i++) {
      const g = truth[i]!;
      const o = cameraAt(plan.camera, i / plan.fps);
      for (const [cx, cy] of corners) {
        const ux = ((cx! - g.x) / g.scale - (cx! - o.x) / o.scale) * g.scale;
        const uy = ((cy! - g.y) / g.scale - (cy! - o.y) / o.scale) * g.scale;
        const px = Math.hypot(ux, uy);
        if (px > worst.px) worst = { px, frame: i, t: round3(i / plan.fps) };
      }
    }
    results["camera.maxErrorPx"] = { ...worst, px: Math.round(worst.px * 1e4) / 1e4 };
    // The ffmpeg expressions must say what cameraAt says (evaluated here with the same functions ffmpeg has).
    const fn = (e: string) =>
      new Function("T", "IF", "gte", "lt", "pow", `return ${e.replaceAll("if(", "IF(")};`) as (t: number, ...f: unknown[]) => number;
    const ff = [(c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => +(a >= b), (a: number, b: number) => +(a < b), Math.pow];
    const ex = { x: fn(cameraExpr(plan.camera, "x")), y: fn(cameraExpr(plan.camera, "y")), scale: fn(cameraExpr(plan.camera, "scale")) };
    let exprWorst = 0;
    for (let i = 0; i < frames; i++) {
      const t = i / plan.fps;
      const o = cameraAt(plan.camera, t);
      const e = { x: ex.x(t, ...ff), y: ex.y(t, ...ff), scale: ex.scale(t, ...ff) };
      for (const [cx, cy] of corners) {
        exprWorst = Math.max(exprWorst, Math.hypot(((cx! - o.x) / o.scale - (cx! - e.x) / e.scale) * o.scale, ((cy! - o.y) / o.scale - (cy! - e.y) / e.scale) * o.scale));
      }
    }
    results["camera.exprVsJsMaxPx"] = exprWorst;
    results["camera.tweens"] = plan.camera;
    await writeFile(join(WORK, "camera-truth.json"), JSON.stringify(truth));
    await save();
    log(`camera: max corner error vs GSAP ${worst.px.toFixed(4)} px at frame ${worst.frame}`);
  } finally {
    await browser.close();
  }
}

/** The stage HTML without the video and without any timed item: just #root and #frame. */
function stageHtml(html: string, extraCss = ""): string {
  const head = html.slice(0, html.indexOf("</head>")).replace(/<link[^>]*fonts\.googleapis[^>]*>/, "").replace(/<script[^>]*><\/script>/, "");
  return `${head}<style>${extraCss}</style></head><body><div id="root"><div id="frame"></div></div></body></html>`;
}

async function backdrop() {
  const plan = await loadPlan(P.build);
  const html = await readFile(join(P.build, "index.html"), "utf8");
  const t = await timed("backdrop", REPEATS, async () => {
    const browser = await chromium.launch({ executablePath: chromePath() });
    try {
      const page = await browser.newPage({ viewport: { width: plan.width, height: plan.height } });
      await page.setContent(stageHtml(html));
      await page.screenshot({ path: P.backdrop });
      // Coverage of the rounded frame, antialiased by Chrome itself: white frame on black, no shadow.
      await page.setContent(
        stageHtml(html, "html,body,#root{background:#000 !important} #frame{background:#fff !important;box-shadow:none !important}"),
      );
      await page.screenshot({ path: P.mask });
    } finally {
      await browser.close();
    }
  });
  log(`backdrop + mask: ${t.median} s`);
}

/** ffmpeg filter graph of the stage: camera through perspective (one resample), rounded mask, onto the backdrop. */
function stageFilter(plan: RenderPlan, src: { width: number; height: number }, interp: "linear" | "cubic"): string {
  const { frame, cam, fps } = plan;
  const kx = src.width / cam.w;
  const ky = src.height / cam.h;
  const W = src.width;
  const H = src.height;
  const total = Math.round(plan.duration * fps);
  const esc = (e: string) => e.replaceAll(",", "\\,");
  // perspective maps output pixel index i to source index x0 + i*(x1-x0)/W. Chrome samples at pixel
  // centres: output centre i+0.5 shows cam point (i+0.5-X)/S, i.e. source index ((i+0.5-X)/S)*kx-0.5.
  const persp = (X: string, Y: string, S: string, evalMode: "init" | "frame") => {
    const x0 = `((0.5-${X})/${S}*${kx}-0.5)`;
    const y0 = `((0.5-${Y})/${S}*${ky}-0.5)`;
    const x1 = `(${x0}+${W}/${S}*${kx})`;
    const y2 = `(${y0}+${H}/${S}*${ky})`;
    return `perspective=x0=${esc(x0)}:y0=${esc(y0)}:x1=${esc(x1)}:y1=${esc(y0)}:x2=${esc(x0)}:y2=${esc(y2)}:x3=${esc(x1)}:y3=${esc(y2)}:interpolation=${interp}:eval=${evalMode}`;
  };
  // Frames where the camera moves get a per-frame perspective; the still spans between them a fixed one
  // (perspective rebuilds its whole lookup table on every frame with eval=frame, which costs as much as the resampling).
  const moving = new Uint8Array(total);
  for (const c of plan.camera) {
    if (c.dur === 0) continue;
    for (let i = Math.max(0, Math.floor(c.t * fps)); i <= Math.min(total - 1, Math.ceil((c.t + c.dur) * fps)); i++) moving[i] = 1;
  }
  const spans: { a: number; b: number; moving: boolean }[] = [];
  for (let i = 0; i < total; i++) {
    const m = !!moving[i];
    const still = !m ? JSON.stringify(cameraAt(plan.camera, i / fps)) : "";
    const last = spans.at(-1);
    if (last && last.moving === m && (m || JSON.stringify(cameraAt(plan.camera, (last.b - 1) / fps)) === still)) last.b = i + 1;
    else spans.push({ a: i, b: i + 1, moving: m });
  }
  const chains = spans.map((s, k) => {
    let p: string;
    if (s.moving) {
      // perspective increments `on` before evaluating: the first frame of the span has on = 1.
      const T = `(${s.a}/${fps}+(on-1)/${fps})`;
      const e = (prop: keyof Cam) => `(${cameraExpr(plan.camera, prop)})`.replaceAll("T", T);
      p = persp(e("x"), e("y"), e("scale"), "frame");
    } else {
      const c = cameraAt(plan.camera, s.a / fps);
      p = persp(`(${c.x})`, `(${c.y})`, `(${c.scale})`, "init");
    }
    return `[v${k}]trim=start_frame=${s.a}:end_frame=${s.b},setpts=PTS-STARTPTS,${p},crop=${frame.w}:${frame.h}:0:0[c${k}]`;
  });
  return [
    `[0:v]scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=gbrp,split=${spans.length}${spans.map((_, k) => `[v${k}]`).join("")}`,
    ...chains,
    `${spans.map((_, k) => `[c${k}]`).join("")}concat=n=${spans.length}:v=1:a=0,setpts=N/${fps}/TB[rec]`,
    `[2:v]crop=${frame.w}:${frame.h}:${frame.left}:${frame.top},format=gray[m]`,
    `[rec][m]alphamerge[recm]`,
    `[1:v]format=gbrp[bg]`,
    `[bg][recm]overlay=${frame.left}:${frame.top}:format=gbrp:shortest=1,format=gbrp[out]`,
  ].join(";");
}

async function stage() {
  const plan = await loadPlan(P.build);
  const edited = join(P.build, "edited.mp4");
  const src = JSON.parse(await sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", edited])).streams[0];
  const interp = (process.env.SPIKE_INTERP as "linear" | "cubic") ?? "linear";
  const filter = stageFilter(plan, src, interp);
  await writeFile(join(WORK, "stage.filter"), filter);
  results["stage.interp"] = interp;
  const t = await timed("stage", REPEATS, () =>
    sh("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", edited,
      "-loop", "1", "-framerate", String(plan.fps), "-i", P.backdrop,
      "-loop", "1", "-framerate", String(plan.fps), "-i", P.mask,
      "-filter_complex_script", join(WORK, "stage.filter"),
      "-map", "[out]",
      "-frames:v", String(Math.round(plan.duration * plan.fps)),
      // Lossless cache (the composite encodes once, at the delivery CRF).
      "-c:v", "libx264rgb", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "rgb24",
      P.stage,
    ]),
  );
  const size = Number((await sh("stat", ["-c", "%s", P.stage])).trim());
  results["stage.sizeMB"] = round2(size / 2 ** 20);
  await save();
  log(`stage: ${t.median} s, ${results["stage.sizeMB"]} MB`);
}

/** The overlay composition: same HTML, no video, every opaque background transparent, no frame shadow (it is in the backdrop). */
function overlayHtml(html: string): string {
  return html
    .replace(/<video id="rec"[^>]*><\/video>/, "")
    .replace(/(html, body \{[^}]*?)background: #000;/, "$1background: transparent;")
    .replace(/(#root \{[^}]*?)background: [^;]+;/, "$1background: transparent;")
    .replace(/(#frame \{[^}]*?)background: #000;/, "$1background: transparent;")
    .replace(/box-shadow: 0 40px 100px rgba\(0,0,0,\.45\), 0 0 0 1px rgba\(255,255,255,\.08\);/, "");
}

async function makeOverlayBuild(build: string, ovlBuild: string) {
  await rm(ovlBuild, { recursive: true, force: true });
  await mkdir(ovlBuild, { recursive: true });
  for (const f of ["gsap.min.js", "hyperframes.json"]) await copyFile(join(build, f), join(ovlBuild, f));
  const html = overlayHtml(await readFile(join(build, "index.html"), "utf8"));
  if (html.includes("<video id=\"rec\"") || html.includes("background: #000;")) throw new Error("overlay HTML still has the video or an opaque background");
  await writeFile(join(ovlBuild, "index.html"), html);
}

async function renderOverlay(ovlBuild: string, out: string) {
  await rm(out, { recursive: true, force: true });
  await hf(["render", ovlBuild, "-o", out, "--format", "png-sequence", "-q", "delivery", "--workers", String(WORKERS), "--quiet"]);
}

async function overlay() {
  await makeOverlayBuild(P.build, P.ovlBuild);
  const t = await timed("overlay", REPEATS, () => renderOverlay(P.ovlBuild, P.ovlOut));
  const files = readdirSync(P.ovlOut).filter((f) => f.endsWith(".png")).sort();
  results["overlay.frames"] = files.length;
  results["overlay.firstFile"] = files[0];
  await save();
  log(`overlay: ${t.median} s, ${files.length} png`);
}

/** HyperFrames' delivery encode (libx264 slow, CRF 15, no B-frames, its x264 params and bt709 tags). */
const DELIVERY_ENC = [
  "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-bf", "0",
  "-x264-params", "aq-mode=3:aq-strength=0.8:deblock=1,1:colorprim=bt709:transfer=bt709:colormatrix=bt709",
  "-pix_fmt", "yuv420p", "-colorspace:v", "bt709", "-color_primaries:v", "bt709", "-color_trc:v", "bt709", "-color_range", "tv",
  "-movflags", "+faststart",
];

async function composeOnce(ovlOut: string, out: string, fps: number) {
  const first = readdirSync(ovlOut).filter((f) => f.endsWith(".png")).sort()[0]!;
  const pattern = first.replace(/\d+(?=\.png$)/, (d) => `%0${d.length}d`);
  const start = Number(first.match(/(\d+)\.png$/)![1]);
  await sh("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", P.stage,
    "-framerate", String(fps), "-start_number", String(start), "-i", join(ovlOut, pattern),
    "-filter_complex",
    // Frame numbers as timestamps in a 1/fps time base on both: Matroska stores ms, so 6.0333 s comes back as 6.033 and would pair with the previous overlay frame.
    `[1:v]settb=1/${fps},setpts=N,format=gbrap[o];[0:v]settb=1/${fps},setpts=N,format=gbrp[s];` +
    "[s][o]overlay=0:0:format=gbrp:eof_action=repeat,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p[v]",
    "-map", "[v]", "-frames:v", String(readdirSync(ovlOut).filter((f) => f.endsWith(".png")).length),
    ...DELIVERY_ENC,
    out,
  ]);
}

async function compose() {
  const plan = await loadPlan(P.build);
  const t = await timed("compose", REPEATS, () => composeOnce(P.ovlOut, P.fast, plan.fps));
  log(`compose: ${t.median} s`);
}

// --- measure ---

/** Per-frame SSIM (ffmpeg) over the whole frame and over the recording box. */
async function ssim(a: string, b: string, box: { left: number; top: number; w: number; h: number }) {
  const whole = join(WORK, "ssim-whole.log");
  const rec = join(WORK, "ssim-rec.log");
  const crop = `crop=${box.w}:${box.h}:${box.left}:${box.top}`;
  await sh("ffmpeg", [
    "-loglevel", "error", "-i", a, "-i", b,
    "-filter_complex",
    `[0:v]split[a0][a1];[1:v]split[b0][b1];[a0][b0]ssim=stats_file=${whole}[w];[a1]${crop}[ac];[b1]${crop}[bc];[ac][bc]ssim=stats_file=${rec}[r]`,
    "-map", "[w]", "-f", "null", "-", "-map", "[r]", "-f", "null", "-",
  ]);
  const parse = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => Number(l.match(/All:([\d.]+)/)![1]));
  return { whole: parse(whole), rec: parse(rec) };
}

/** Per-frame max and 99.9th percentile absolute RGB difference, whole frame and recording box. */
async function absDiff(a: string, b: string, W: number, H: number, box: { left: number; top: number; w: number; h: number }) {
  const dec = (f: string) =>
    spawn("ffmpeg", ["-loglevel", "error", "-i", f, "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "-"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
  const pa = dec(a);
  const pb = dec(b);
  const size = W * H * 3;
  const reader = (p: ReturnType<typeof dec>) => {
    const chunks: Buffer[] = [];
    let have = 0;
    let done = false;
    let wake: (() => void) | undefined;
    p.stdout!.on("data", (d: Buffer) => {
      chunks.push(d);
      have += d.length;
      wake?.();
    });
    p.stdout!.on("end", () => {
      done = true;
      wake?.();
    });
    return async (): Promise<Buffer | null> => {
      while (have < size && !done) await new Promise<void>((r) => (wake = r));
      if (have < size) return null;
      const all = Buffer.concat(chunks);
      const frame = all.subarray(0, size);
      chunks.length = 0;
      chunks.push(all.subarray(size));
      have -= size;
      return frame;
    };
  };
  const ra = reader(pa);
  const rb = reader(pb);
  const out: { maxWhole: number; p999Whole: number; meanWhole: number; maxRec: number; p999Rec: number; meanRec: number }[] = [];
  for (;;) {
    const [fa, fb] = await Promise.all([ra(), rb()]);
    if (!fa || !fb) break;
    const histW = new Uint32Array(256);
    const histR = new Uint32Array(256);
    let sumW = 0;
    let sumR = 0;
    for (let y = 0; y < H; y++) {
      const inY = y >= box.top && y < box.top + box.h;
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3;
        const d = Math.max(Math.abs(fa[o]! - fb[o]!), Math.abs(fa[o + 1]! - fb[o + 1]!), Math.abs(fa[o + 2]! - fb[o + 2]!));
        histW[d]!++;
        sumW += d;
        if (inY && x >= box.left && x < box.left + box.w) {
          histR[d]!++;
          sumR += d;
        }
      }
    }
    const stats = (h: Uint32Array, total: number) => {
      let max = 0;
      for (let i = 255; i >= 0; i--) if (h[i]) { max = i; break; }
      let acc = 0;
      let p = 0;
      for (let i = 255; i >= 0; i--) {
        acc += h[i]!;
        if (acc > total * 0.001) { p = i; break; }
      }
      return { max, p };
    };
    const sw = stats(histW, W * H);
    const sr = stats(histR, box.w * box.h);
    out.push({ maxWhole: sw.max, p999Whole: sw.p, meanWhole: round3(sumW / (W * H)), maxRec: sr.max, p999Rec: sr.p, meanRec: round3(sumR / (box.w * box.h)) });
  }
  pa.kill();
  pb.kill();
  return out;
}

const summary = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: round3(xs.reduce((a, b) => a + b, 0) / xs.length) || 0, min: s[0], p1: s[Math.floor(s.length * 0.01)], median: s[Math.floor(s.length / 2)], max: s.at(-1) };
};

async function measureVs(name: string, fast: string, refFile: string, build: string) {
  const plan = await loadPlan(build);
  const s = await ssim(fast, refFile, plan.frame);
  const ssimWholeMean = s.whole.reduce((a, b) => a + b, 0) / s.whole.length;
  const ssimRecMean = s.rec.reduce((a, b) => a + b, 0) / s.rec.length;
  const worst = (xs: number[]) => xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).slice(0, 8).map(({ v, i }) => ({ frame: i, t: round3(i / plan.fps), ssim: round3(v * 1000) / 1000 }));
  const d = await absDiff(fast, refFile, plan.width, plan.height, plan.frame);
  const m = {
    frames: { fast: s.whole.length, diffed: d.length },
    ssimWhole: { ...summary(s.whole), mean: Math.round(ssimWholeMean * 1e5) / 1e5, worst: worst(s.whole) },
    ssimRec: { ...summary(s.rec), mean: Math.round(ssimRecMean * 1e5) / 1e5, worst: worst(s.rec) },
    maxAbsWhole: summary(d.map((x) => x.maxWhole)),
    p999AbsWhole: summary(d.map((x) => x.p999Whole)),
    meanAbsWhole: summary(d.map((x) => x.meanWhole)),
    maxAbsRec: summary(d.map((x) => x.maxRec)),
    p999AbsRec: summary(d.map((x) => x.p999Rec)),
    meanAbsRec: summary(d.map((x) => x.meanRec)),
  };
  await writeFile(join(WORK, `${name}-perframe.json`), JSON.stringify({ ssimWhole: s.whole, ssimRec: s.rec, diff: d }));
  results[`measure.${name}`] = m;
  await save();
  log(`${name}: SSIM whole mean ${m.ssimWhole.mean} min ${m.ssimWhole.min}; rec mean ${m.ssimRec.mean} min ${m.ssimRec.min}`);
}

async function measure() {
  await measureVs("fast-vs-chrome", P.fast, P.ref, P.build);
}

/** Restyle: another accent and caption colour; only the overlay and the composite run again. */
async function restyle() {
  const sb = JSON.parse(await readFile(P.sb, "utf8"));
  sb.theme = { ...sb.theme, accent: "#22c55e", captionColor: "#fde68a", captionBackground: "rgba(127, 29, 29, 0.88)" };
  await writeFile(P.restyleSb, JSON.stringify(sb, null, 2));
  await prepareBuild(P.restyleSb, { buildDir: P.restyleBuild, log });
  const plan = await loadPlan(P.restyleBuild);
  const base = await loadPlan(P.build);
  if (JSON.stringify({ f: plan.frame, c: plan.camera, b: plan.theme.background, p: plan.theme.padding }) !== JSON.stringify({ f: base.frame, c: base.camera, b: base.theme.background, p: base.theme.padding })) {
    throw new Error("restyle changed the stage; the spike assumes it does not");
  }
  await makeOverlayBuild(P.restyleBuild, P.restyleOvlBuild);
  const t = await timed("restyle", REPEATS, async () => {
    await renderOverlay(P.restyleOvlBuild, P.restyleOvlOut);
    await composeOnce(P.restyleOvlOut, P.restyleFast, plan.fps);
  });
  log(`restyle (overlay + compose): ${t.median} s`);
  if (process.env.SPIKE_RESTYLE_REF) {
    const refR = join(WORK, "restyle-ref.mp4");
    await hf(["render", P.restyleBuild, "-o", refR, "-q", "delivery", "--video-frame-format", "auto", "--workers", String(WORKERS), "--quiet"]);
    await measureVs("restyle-vs-chrome", P.restyleFast, refR, P.restyleBuild);
  }
}

const table: Record<string, () => Promise<void>> = { prep, ref, camera, backdrop, stage, overlay, compose, measure, restyle };
for (const s of ["prep", "ref", "camera", "backdrop", "stage", "overlay", "compose", "measure", "restyle"]) {
  if (steps.has(s)) {
    log(`== ${s}`);
    await table[s]!();
  }
}
