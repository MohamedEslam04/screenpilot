import { homedir } from "node:os";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "../util/exec.js";
import { type CommandVoice, loadVoiceConfig, voicesFile } from "./config.js";
import type { VoiceInfo, VoiceProvider } from "./index.js";
import { detectLang, rateToSpeed } from "./text.js";

// Any program that turns text into an audio file: Piper, Kokoro, a script of your own.
// The voice name picks an entry in voices.json (see voices file in the docs).

function profile(voice: string): CommandVoice {
  const found = loadVoiceConfig().commands[voice];
  if (found) return found;
  const names = Object.keys(loadVoiceConfig().commands);
  throw new Error(
    names.length
      ? `No command voice "${voice}" in ${voicesFile()}. Defined: ${names.join(", ")}`
      : `No command voices defined. Add one to ${voicesFile()}, e.g. {"commands": {"${voice}": {"command": ["my-tts", "--out", "{out}"], "stdin": "{text}"}}}`,
  );
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(text|rate|speed|lang|out)\}/g, (_, k: string) => vars[k]!);
}

const expandHome = (arg: string) => (arg.startsWith("~/") ? homedir() + arg.slice(1) : arg);

export const commandProvider: VoiceProvider = {
  id: "command",

  ext: (voice) => profile(voice).ext,

  cacheKey: (voice) => JSON.stringify(profile(voice).command),

  async synthesize(text, voice, rate, outFile) {
    const p = profile(voice);
    // Some programs pick the format from the extension, so the partial file keeps it.
    const tmp = `${outFile.slice(0, outFile.length - p.ext.length - 1)}.part.${p.ext}`;
    const vars = { text, rate, speed: String(rateToSpeed(rate)), lang: detectLang(text), out: tmp };
    const [cmd, ...args] = p.command.map((a) => expandHome(fill(a, vars)));
    await mkdir(dirname(outFile), { recursive: true });
    await run(cmd!, args, { env: p.env, input: p.stdin === undefined ? undefined : fill(p.stdin, vars), timeoutMs: p.timeout * 1000 });
    const size = await stat(tmp).then((s) => s.size, () => 0);
    if (!size) throw new Error(`The command for voice "${voice}" finished but wrote no audio to {out}. Check "command" in ${voicesFile()}.`);
    await rename(tmp, outFile);
  },

  async listVoices(): Promise<VoiceInfo[]> {
    return Object.keys(loadVoiceConfig().commands).map((name) => ({ name, locale: "any", gender: "" }));
  },
};
