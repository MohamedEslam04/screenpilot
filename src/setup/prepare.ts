import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStoryboard } from "../init.js";
import { hyperframesBin, hyperframesEnv, renderStoryboard } from "../render/index.js";
import { run } from "../util/exec.js";

// First-run downloads happen here, while the user expects to wait, instead of
// silently inside their first video: the headless Chrome HyperFrames renders
// with (~100 MB unless Google Chrome is installed) and the caption fonts.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PrepareResult {
  ok: boolean;
  detail: string;
}

/** Find or download the render browser, retrying flaky downloads. */
export async function ensureRenderBrowser(log: (m: string) => void, attempts = 3): Promise<string> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      // After a failure, --force clears a partial download instead of reusing it.
      await run(process.execPath, [hyperframesBin(), "browser", "ensure", ...(i > 1 ? ["--force"] : [])], { env: hyperframesEnv() });
      const { stdout } = await run(process.execPath, [hyperframesBin(), "browser", "path"], { env: hyperframesEnv() });
      return stdout.trim().split("\n").at(-1) ?? "";
    } catch (err) {
      last = err;
      if (i < attempts) {
        log(`render browser download failed (attempt ${i}/${attempts}); retrying`);
        await sleep(3000 * i);
      }
    }
  }
  const why = (last as Error).message.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  throw new Error(`Could not download the video renderer (check the internet connection): ${why}`);
}

/** Render a 2-second test clip with an Arabic + English caption: fetches fonts and proves rendering works here. */
export async function warmUpRender(log: (m: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "screenpilot-warmup-"));
  try {
    const video = join(dir, "test.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "2", "-pix_fmt", "yuv420p", "-y", video]);
    const { storyboard } = await initStoryboard(video, { out: join(dir, "storyboard.json") });
    const sb = JSON.parse(await readFile(storyboard, "utf8")) as Record<string, unknown>;
    sb.captions = [{ at: 0.2, dur: 1.5, text: "ScreenPilot جاهز" }];
    await writeFile(storyboard, JSON.stringify(sb));
    const out = join(dir, "out.mp4");
    await renderStoryboard(storyboard, { output: out, quality: "draft", workers: 1, log });
    if (!existsSync(out)) throw new Error("the test render produced no file");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function prepareRenderer(log: (m: string) => void): Promise<PrepareResult> {
  try {
    log("preparing the video renderer (first time only; may download ~100 MB)");
    const browser = await ensureRenderBrowser(log);
    await warmUpRender(log);
    return { ok: true, detail: `ready (${browser})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.split("\n")[0] ?? String(err) };
  }
}
