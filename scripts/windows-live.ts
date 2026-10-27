// Full check on a real Windows PC (multi-monitor, real DPI, real apps):
//   pnpm windows:live
// Runs doctor (with input injection), the smoke test, then performs a
// narrated take across your monitors and renders it. Everything lands in
// windows-live-report/ — send that folder back.

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { doctor } from "../src/doctor.js";
import { getDesktop } from "../src/platform/index.js";
import { renderStoryboard } from "../src/render/index.js";
import { performTake } from "../src/take/perform.js";

const OUT = resolve("windows-live-report");
const log = (m: string) => process.stderr.write(`live: ${m}\n`);
const steps: { name: string; ok: boolean; detail: string }[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  log(`${name}…`);
  try {
    steps.push({ name, ok: true, detail: await fn() });
  } catch (err) {
    steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  log(`${steps.at(-1)!.ok ? "ok  " : "FAIL"} ${name}: ${steps.at(-1)!.detail}`);
}

function sh(cmd: string, args: string[]): Promise<number> {
  return new Promise((res) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }).on("close", (c) => res(c ?? 1)));
}

function page(): string {
  const dir = mkdtempSync(join(tmpdir(), "live-page-"));
  const file = join(dir, "index.html");
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>Acme Reports</title>
<body style="margin:0;font:20px system-ui;background:#f8fafc">
<header style="background:#4338ca;color:#fff;padding:22px 40px;font-size:26px;font-weight:700">Acme Reports</header>
<main style="padding:40px"><h2>Monthly report</h2>
<input id="name" placeholder="Report name" style="font-size:20px;padding:10px;width:320px"><br>
<button id="gen" style="margin-top:18px;font-size:20px;padding:12px 22px">Generate</button>
<div id="done" style="display:none;margin-top:16px;color:#15803d">Report ready ✓</div></main>
<script>document.getElementById("gen").onclick=()=>setTimeout(()=>document.getElementById("done").style.display="block",600)</script>`,
  );
  return pathToFileURL(file).href;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  await step("doctor --input", async () => {
    const r = await doctor({ input: true });
    writeFileSync(join(OUT, "doctor.json"), `${JSON.stringify(r, null, 2)}\n`);
    return r.summary;
  });

  await step("smoke test", async () => {
    const code = await sh("pnpm", ["smoke:windows"]);
    return code === 0 ? "all checks passed (see smoke-report/)" : Promise.reject(new Error(`smoke failed (exit ${code}); see smoke-report/`));
  });

  await step("narrated take across monitors + render", async () => {
    const screens = await (await getDesktop()).screens();
    const first = screens[0]!.name;
    const second = (screens[1] ?? screens[0]!).name;
    const dir = mkdtempSync(join(tmpdir(), "live-take-"));
    const take = join(dir, "take.json");
    writeFileSync(
      take,
      JSON.stringify(
        {
          screens: "all",
          voice: { name: "en-US-AndrewNeural" },
          setup: [{ browser: { screen: first, url: page() } }],
          steps: [
            { say: "Here is the report page." },
            { click: { web: "#name" } },
            { type: "October summary" },
            { click: { web: "#gen" } },
            { waitFor: { web: "text=Report ready" } },
            { say: "ونكتب ملاحظة على الشاشة التانية.", voice: "ar-EG-SalmaNeural" },
            { run: ["notepad.exe"] },
            { waitForWindow: { match: "notepad", timeout: 15 } },
            { focus: { match: "notepad", screen: second } },
            { click: { window: "notepad", x: 0.5, y: 0.5 } },
            { type: "Report sent ✓ مرحبا" },
            { wait: 1 },
          ],
        },
        null,
        2,
      ),
    );
    const r = await performTake(take, { dir: join(OUT, "take"), log });
    const out = join(OUT, "take-draft.mp4");
    await renderStoryboard(r.storyboard!, { output: out, quality: "draft", log });
    copyFileSync(take, join(OUT, "take.json"));
    return `${r.recording?.video} → ${out}`;
  });
}

await main();
writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(steps, null, 2)}\n`);
log(`${steps.filter((s) => s.ok).length}/${steps.length} steps ok — send the folder ${OUT}`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);
