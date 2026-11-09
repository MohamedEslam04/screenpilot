import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

/** The per-project settings file. It sits in the project's root folder. */
export const PROJECT_FILE = ".screenpilot.json";

const ProjectSchema = z.object({ output: z.string().min(1) }).strict();

/**
 * `output` must stay inside the project folder: a cloned repo carries this file, and it must not be
 * able to send recordings to any other place on the disk.
 */
function insideFolder(base: string, output: string): string | undefined {
  if (isAbsolute(output)) return undefined;
  const abs = resolve(base, output);
  const rel = relative(base, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return abs;
}

function folderOf(start: string): string {
  const abs = resolve(start);
  try {
    return statSync(abs).isFile() ? dirname(abs) : abs;
  } catch {
    return abs; // not created yet: walk up from where it would be
  }
}

/** The nearest `.screenpilot.json` at or above `start` (a folder or a file). */
export function findProjectFile(start: string): string | undefined {
  let dir = folderOf(start);
  for (;;) {
    const file = join(dir, PROJECT_FILE);
    if (existsSync(file)) return file;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The video folder the project asks for (absolute), or undefined when no project file is found. Throws on a bad file. */
export function projectOutput(start: string): string | undefined {
  const file = findProjectFile(start);
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
  const parsed = ProjectSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ");
    throw new Error(`${file}: ${why}. Expected {"output": "videos"}`);
  }
  const out = insideFolder(dirname(file), parsed.data.output);
  if (!out) throw new Error(`${file}: "output" must be a folder inside the project (no absolute path, no ".."), got "${parsed.data.output}"`);
  return out;
}

/** Write `<dir>/.screenpilot.json` with `output` (must stay inside `dir`). Returns the file path. */
export function writeProjectOutput(dir: string, output: string): string {
  const base = resolve(dir);
  if (!insideFolder(base, output)) throw new Error(`"${output}" must be a folder inside ${base} (no absolute path, no "..")`);
  const file = join(base, PROJECT_FILE);
  writeFileSync(file, `${JSON.stringify({ output }, null, 2)}\n`);
  return file;
}
