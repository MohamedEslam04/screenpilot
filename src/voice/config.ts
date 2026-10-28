import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { APP, configDir } from "../brand.js";

/** Env var naming the voices file (default: voices.json in the config folder). */
export const VOICES_FILE_ENV = `${APP.toUpperCase()}_VOICES_FILE`;

// A "command" voice: any program that turns text into an audio file. It lives in the
// user's own file, never in a storyboard, so a shared project cannot run programs.
const CommandVoiceSchema = z
  .object({
    command: z.array(z.string()).min(1).describe("Program and arguments (no shell). Placeholders: {text} {rate} {speed} {lang} {out}"),
    stdin: z.string().optional().describe("Text sent to the program's stdin, e.g. \"{text}\""),
    ext: z.string().regex(/^[a-z0-9]{2,5}$/).default("wav").describe("Extension of the file the program writes to {out}"),
    timeout: z.number().positive().default(120).describe("Seconds before one line is given up"),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const VoiceConfigSchema = z
  .object({
    commands: z.record(z.string(), CommandVoiceSchema).prefault({}),
    local: z
      .object({
        python: z.string().optional().describe("Python that has the local voice models installed"),
        env: z.record(z.string(), z.string()).optional().describe("Environment for the model process, e.g. HF_HOME for the weights folder"),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type CommandVoice = z.infer<typeof CommandVoiceSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

export function voicesFile(): string {
  return process.env[VOICES_FILE_ENV] || join(configDir(), "voices.json");
}

export function loadVoiceConfig(): VoiceConfig {
  const file = voicesFile();
  if (!existsSync(file)) return VoiceConfigSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const r = VoiceConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid ${file}:\n${r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return r.data;
}

/** Change the voices file, keeping everything else the user wrote in it. */
export async function updateVoiceConfig(change: (raw: Record<string, unknown>) => void): Promise<string> {
  const file = voicesFile();
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(raw);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  return file;
}
