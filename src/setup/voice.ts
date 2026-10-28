import { existsSync, rmSync } from "node:fs";
import { mkdir, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { APP } from "../brand.js";
import { run } from "../util/exec.js";
import { updateVoiceConfig, voicesFile } from "../voice/config.js";
import { LOCAL_MODELS, LocalWorker, type LocalModel, workerScript } from "../voice/local.js";
import { appHome } from "./index.js";

// Sets up the models for `voice.provider: "local"` in an environment of their own, so nothing
// touches the user's Python. Third-party code is pinned to the commits this was tested with.

const OMNIVOICE = "https://github.com/k2-fsa/OmniVoice/archive/08be0b4ccbac3e13e374e86fbfead4b4cac343e2.zip";
const VOICETUT = "https://github.com/MohamedAly22/VoiceTuT-TTS/archive/44cba00cd3ddb04b5213353e19e960045e332da7.zip";
const CHATTERBOX_DEPS = [
  "librosa==0.11.0",
  "transformers",
  "safetensors",
  "soundfile",
  "huggingface_hub",
  "diffusers==0.29.0",
  "conformer==0.3.2",
  "resemble-perth",
  "s3tokenizer",
  "pykakasi==2.3.0",
  "pyloudnorm",
  "omegaconf",
  "spacy-pkuseg",
];

/** Disk the install needs, in GB: the Python environment (once) and the model's downloads. */
const DISK_GB = { env: { final: 8, peak: 12 }, voicetut: { final: 2.5, peak: 3 }, namaa: { final: 5.5, peak: 6 } };

export interface VoiceSetupOptions {
  model?: LocalModel;
  /** Folder for the environment and the downloaded models. Default: next to the app folder. */
  dir?: string;
  /** Do not ask before downloading. */
  yes?: boolean;
  log?: (line: string) => void;
}

export interface VoiceSetupResult {
  model: LocalModel;
  dir: string;
  python: string;
  voicesFile: string;
  seconds: number;
}

/** Not inside the app folder: setup wipes that folder on every update. */
export function voiceHome(dir?: string): string {
  return resolve(dir ?? `${appHome()}-voices`);
}

const venvPython = (home: string) => (process.platform === "win32" ? join(home, "venv", "Scripts", "python.exe") : join(home, "venv", "bin", "python"));

async function works(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await run(cmd, args)).stdout.trim() || "ok";
  } catch {
    return undefined;
  }
}

async function freeGb(path: string): Promise<number> {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = await statfs(p);
  return (Number(s.bavail) * Number(s.bsize)) / 2 ** 30;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Which PyTorch build to install: CUDA only where there is an NVIDIA GPU, CPU-only elsewhere on Linux and Windows. */
async function torchIndex(): Promise<string[]> {
  const nvidia = (await works("nvidia-smi", ["-L"])) !== undefined;
  if (process.platform === "darwin") return [];
  if (nvidia) return process.platform === "win32" ? ["--index-url", "https://download.pytorch.org/whl/cu128", "--extra-index-url", "https://pypi.org/simple"] : [];
  return ["--index-url", "https://download.pytorch.org/whl/cpu", "--extra-index-url", "https://pypi.org/simple"];
}

export async function voiceSetup(opts: VoiceSetupOptions = {}): Promise<VoiceSetupResult> {
  const log = opts.log ?? (() => {});
  const model = opts.model ?? "voicetut";
  if (!LOCAL_MODELS.includes(model)) throw new Error(`Unknown model "${model}". Choose ${LOCAL_MODELS.join(" or ")}.`);
  const home = voiceHome(opts.dir);
  const python = venvPython(home);
  const fresh = !existsSync(python);

  const uv = (await works("uv", ["--version"])) !== undefined;
  if (!uv) {
    throw new Error(
      `${APP} voice-setup needs "uv" (it also fetches the right Python). Install it from https://docs.astral.sh/uv/getting-started/installation/ and run this again.`,
    );
  }

  const need = (fresh ? DISK_GB.env : { final: 0, peak: 0 }).peak + DISK_GB[model].peak;
  const final = (fresh ? DISK_GB.env : { final: 0 }).final + DISK_GB[model].final;
  const free = await freeGb(home);
  log(`${model}: needs about ${final} GB in ${home} (up to ${need} GB while installing); ${free.toFixed(0)} GB free there.`);
  if (free < need) throw new Error(`Not enough disk space in ${home}: ${free.toFixed(1)} GB free, ${need} GB needed. Use --dir to pick another drive.`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error("This downloads several GB. Run it in a terminal to confirm, or pass --yes.");
    if (!(await confirm("It also installs third-party code (OmniVoice, VoiceTut, PyTorch) into that folder. Continue?"))) throw new Error("Cancelled.");
  }

  const started = Date.now();
  await mkdir(home, { recursive: true });
  // A uv package cache or Hugging Face folder the user already points at is reused, not downloaded again.
  const ownUvCache = !process.env.UV_CACHE_DIR;
  const env = {
    UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(home, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(home, "python"),
    UV_HTTP_TIMEOUT: "600",
    HF_HOME: process.env.HF_HOME ?? join(home, "hf"),
  };
  const uvRun = (args: string[]) => run("uv", args, { env, inherit: true });
  const pip = (...pkgs: string[]) => uvRun(["pip", "install", "--python", python, ...pkgs]);

  if (fresh) {
    log("creating the Python environment");
    await uvRun(["venv", "--python", "3.11", join(home, "venv")]);
    log("installing PyTorch (large)");
    await pip("torch", "torchaudio", ...(await torchIndex()));
  }
  log(`installing ${model}`);
  if (model === "voicetut") {
    await pip(OMNIVOICE, VOICETUT, "soundfile");
  } else {
    await pip("chatterbox-tts==0.1.7", "--no-deps");
    await pip(...CHATTERBOX_DEPS);
  }

  // One real line: downloads the weights exactly as a render would, and proves the install works.
  log("downloading the model and trying one line (the first run is the slow one)");
  const worker = new LocalWorker({
    command: python,
    args: [workerScript()],
    env: { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", HF_HUB_DOWNLOAD_TIMEOUT: "120", HF_HUB_DISABLE_XET: "1", HF_HOME: env.HF_HOME },
  });
  try {
    const reply = await worker.request(
      { cmd: "synth", model, voice: null, lang: model === "namaa" ? "ar" : "en", text: model === "namaa" ? "مرحبا بيك" : "Hello, this is a test.", speed: 1, out: join(home, "check.wav") },
      4 * 3600_000,
    );
    if (!reply.ok) throw new Error(reply.error ?? "The model failed its test line.");
  } finally {
    await worker.close();
  }

  // The package cache is only needed while installing; the environment keeps its own files.
  if (ownUvCache) rmSync(env.UV_CACHE_DIR, { recursive: true, force: true });
  const file = await updateVoiceConfig((raw) => {
    const local = (raw.local ?? {}) as Record<string, unknown>;
    raw.local = { ...local, python, env: { ...(local.env as Record<string, string> | undefined), HF_HOME: env.HF_HOME } };
  });
  return { model, dir: home, python, voicesFile: file ?? voicesFile(), seconds: Math.round((Date.now() - started) / 1000) };
}
