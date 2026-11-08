import { mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

async function isUsable(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

/** `dir` when it does not exist or is empty, else the first free `${dir}-2`, `${dir}-3`, ... */
export async function freeSessionDir(dir: string): Promise<string> {
  if (await isUsable(dir)) return dir;
  for (let n = 2; ; n++) {
    const candidate = `${dir}-${n}`;
    if (await isUsable(candidate)) return candidate;
  }
}

/**
 * Pick and create the directory a take records into, and point `${dir}-latest` at it.
 * Default: never touch an earlier take (version the name). `overwrite`: move the earlier take to
 * `${dir}.prev` (replacing an older one) and reuse `dir`.
 */
export async function prepareSessionDir(dir: string, opts: { overwrite?: boolean } = {}): Promise<string> {
  const base = resolve(dir);
  let used: string;
  if (opts.overwrite && !(await isUsable(base))) {
    await rm(`${base}.prev`, { recursive: true, force: true });
    await rename(base, `${base}.prev`);
    used = base;
  } else {
    used = await freeSessionDir(base);
  }
  await mkdir(used, { recursive: true });
  const latest = `${base}-latest`;
  await rm(latest, { force: true }); // only the link: never follows it
  await symlink(basename(used), latest);
  return used;
}
