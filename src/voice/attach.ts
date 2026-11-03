import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

/**
 * Point each narration line at its audio file. `files` are in speaking order,
 * so the i-th file goes to the i-th line by time, whatever order the lines have
 * in the JSON. Paths are stored relative to the storyboard.
 */
export async function attachAudio(storyboardPath: string, files: string[]): Promise<void> {
  const path = resolve(storyboardPath);
  const raw = JSON.parse(await readFile(path, "utf8")) as { narration?: { at: number; audio?: string }[] };
  const lines = raw.narration ?? [];
  if (files.length !== lines.length) {
    throw new Error(`${files.length} audio file(s) for ${lines.length} narration line(s): the numbers must match.`);
  }
  const order = lines.map((l, i) => ({ i, at: l.at })).sort((a, b) => a.at - b.at || a.i - b.i);
  order.forEach(({ i }, k) => {
    lines[i]!.audio = relative(dirname(path), resolve(files[k]!)).split("\\").join("/");
  });
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}
