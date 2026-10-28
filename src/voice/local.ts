import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { APP } from "../brand.js";
import { loadVoiceConfig } from "./config.js";
import type { VoiceInfo, VoiceProvider } from "./index.js";
import { rateToSpeed } from "./text.js";

// Speech models that run on this computer (VoiceTut, NAMAA). A Python process (python/tts_worker.py)
// keeps the model loaded and answers one JSON line per request; see that file for the protocol.

/** Env var naming the Python that has the models installed (else voices.json, else `voice-setup`). */
export const LOCAL_PYTHON_ENV = `${APP.toUpperCase()}_LOCAL_PYTHON`;
/** auto (default), cuda, cpu or mps. Read by the worker. */
export const LOCAL_DEVICE_ENV = `${APP.toUpperCase()}_LOCAL_DEVICE`;

export const LOCAL_MODELS = ["voicetut", "namaa"] as const;
export type LocalModel = (typeof LOCAL_MODELS)[number];

/** "voicetut:Sarah" -> model voicetut, voice Sarah. "namaa" or "voicetut" alone use the model's default voice. */
export function parseLocalVoice(name: string): { model: LocalModel; voice: string | null } {
  const [model, ...rest] = name.split(":");
  if (!LOCAL_MODELS.includes(model as LocalModel)) {
    throw new Error(`Unknown local voice "${name}". Use ${LOCAL_MODELS.map((m) => `"${m}" or "${m}:<voice>"`).join(", ")} (list them with: ${APP} voices --provider local).`);
  }
  return { model: model as LocalModel, voice: rest.join(":") || null };
}

export interface WorkerLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface Reply {
  id?: number | null;
  ok?: boolean;
  ready?: boolean;
  error?: string;
  [key: string]: unknown;
}

const READY_TIMEOUT = 60_000;
const FIRST_SYNTH_TIMEOUT = 300_000; // includes loading the model
const SYNTH_TIMEOUT = 120_000;

/** One worker process and its request/reply bookkeeping. */
export class LocalWorker {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly tail: string[] = [];
  private readonly ready: Promise<void>;
  private nextId = 1;
  private stopped = false;
  synthCount = 0;

  constructor(launch: WorkerLaunch) {
    this.child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
    let onReady: () => void;
    let onFail: (e: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      onFail = reject;
    });
    this.ready.catch(() => {});
    const readyTimer = setTimeout(() => onFail(new Error(`The voice engine did not start in ${READY_TIMEOUT / 1000} s.${this.detail()}`)), READY_TIMEOUT);

    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let msg: Reply;
      try {
        msg = JSON.parse(line) as Reply;
      } catch {
        this.remember(line);
        return;
      }
      if (msg.ready) {
        clearTimeout(readyTimer);
        onReady();
        return;
      }
      const wait = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!wait) return;
      clearTimeout(wait.timer);
      this.pending.delete(msg.id as number);
      wait.resolve(msg);
    });
    createInterface({ input: this.child.stderr! }).on("line", (line) => {
      this.remember(line);
      process.stderr.write(`[voice] ${line}\n`);
    });
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (err) => this.fail(new Error(`Cannot start the voice engine (${launch.command}): ${err.message}`), onFail));
    this.child.on("close", (code, signal) => {
      clearTimeout(readyTimer);
      // The system kills a process that runs out of memory: no message from the engine itself.
      const killed = signal === "SIGKILL" || code === 137;
      const hint = killed ? " It was probably killed for lack of memory: close other programs, or use the voicetut model (it needs less)." : "";
      this.fail(new Error(`The voice engine stopped (${signal ?? `exit ${code}`}).${hint}${this.detail()}`), onFail);
    });
  }

  get dead(): boolean {
    return this.stopped;
  }

  private remember(line: string): void {
    this.tail.push(line);
    if (this.tail.length > 30) this.tail.shift();
  }

  private detail(): string {
    const last = this.tail.slice(-8).join("\n");
    return last ? `\n${last}` : "";
  }

  private fail(err: Error, onFail: (e: Error) => void): void {
    this.stopped = true;
    onFail(err);
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
  }

  async request(msg: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    await this.ready;
    if (this.stopped) throw new Error(`The voice engine is not running.${this.detail()}`);
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stopped = true;
        this.child.kill();
        reject(new Error(`The voice engine did not answer in ${Math.round(timeoutMs / 1000)} s.${this.detail()}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ id, ...msg })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin!.write(`${JSON.stringify({ id: 0, cmd: "quit" })}\n`);
    this.child.stdin!.end();
    const killer = setTimeout(() => this.child.kill(), 3000);
    await exited;
    clearTimeout(killer);
  }
}

export function workerScript(): string {
  return fileURLToPath(new URL("../../python/tts_worker.py", import.meta.url));
}

/** The Python that has the models: env var, else voices.json (written by voice-setup). */
export function resolvePython(): string {
  const python = process.env[LOCAL_PYTHON_ENV] || loadVoiceConfig().local.python;
  if (!python) {
    throw new Error(
      `No local voice engine is set up. Run "${APP} voice-setup voicetut", or set ${LOCAL_PYTHON_ENV} to a Python that has a model installed.`,
    );
  }
  return python;
}

export function defaultLaunch(): WorkerLaunch {
  return {
    command: resolvePython(),
    args: [workerScript()],
    env: { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", HF_HUB_DOWNLOAD_TIMEOUT: "120", ...loadVoiceConfig().local.env },
  };
}

export function createLocalProvider(launch: () => WorkerLaunch): VoiceProvider {
  let worker: LocalWorker | undefined;
  const current = () => (worker && !worker.dead ? worker : (worker = new LocalWorker(launch())));

  return {
    id: "local",

    ext: () => "wav",

    async synthesize(text, voice, rate, outFile) {
      const { model, voice: speaker } = parseLocalVoice(voice);
      const w = current();
      const reply = await w.request(
        { cmd: "synth", model, voice: speaker, lang: null, text, speed: rateToSpeed(rate), out: outFile },
        w.synthCount++ === 0 ? FIRST_SYNTH_TIMEOUT : SYNTH_TIMEOUT,
      );
      if (!reply.ok) throw new Error(reply.error ?? "The voice engine failed without saying why.");
    },

    async listVoices(): Promise<VoiceInfo[]> {
      const w = current();
      const reply = await w.request({ cmd: "voices" }, READY_TIMEOUT);
      if (!reply.ok) throw new Error(reply.error ?? "The voice engine could not list voices.");
      const models = (reply.models ?? []) as { name: string; langs: string[]; voices: string[]; installed: boolean }[];
      return models
        .filter((m) => m.installed)
        .flatMap((m) =>
          m.voices.map((v) => ({
            name: v === "default" ? m.name : `${m.name}:${v}`,
            locale: m.langs.includes("ar") ? "ar-EG" : "en-US",
            gender: "",
            langs: m.langs,
          })),
        );
    },

    async close() {
      const w = worker;
      worker = undefined;
      await w?.close();
    },
  };
}

export const localProvider = createLocalProvider(defaultLaunch);
