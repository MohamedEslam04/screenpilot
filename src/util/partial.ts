import { rename, rm } from "node:fs/promises";

/** `<name>.partial.<ext>`: where a video is written until it is complete. */
export const partialPath = (file: string): string => file.replace(/(\.[^./\\]+)?$/, ".partial$1");

/**
 * Let `write` make `<name>.partial.<ext>`, then rename it to `file`, so anyone
 * watching the folder sees a complete file or none (an mp4 without its moov atom
 * does not play). A failed or aborted write removes the partial file and leaves an
 * earlier `file` untouched.
 */
export async function writeAtomically<T>(file: string, write: (partial: string) => Promise<T>): Promise<T> {
  const partial = partialPath(file);
  await rm(partial, { force: true });
  try {
    const r = await write(partial);
    await rename(partial, file);
    return r;
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}
