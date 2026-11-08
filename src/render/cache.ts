import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** An entry modified this recently may belong to a render that is running: never delete it. */
export const KEEP_RECENT_MS = 10 * 60_000;

/** Cap for the render cache in bytes: $SCREENPILOT_RENDER_CACHE_GB (default 4 GB). */
export function renderCacheLimit(): number {
  return (Number(process.env.SCREENPILOT_RENDER_CACHE_GB) || 4) * 2 ** 30;
}

/** Size of a file, or of a folder with everything inside it. 0 when it does not exist. */
async function sizeOf(path: string): Promise<number> {
  try {
    const st = await lstat(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of await readdir(path)) total += await sizeOf(join(path, name));
    return total;
  } catch {
    return 0;
  }
}

export const cacheSize = sizeOf;

/**
 * Delete top-level entries of `dir`, oldest modification time first, until
 * the total is at most `maxBytes`. An entry modified in the last 10 minutes
 * is never deleted, even if the cap is still exceeded afterwards.
 */
export async function pruneCache(dir: string, maxBytes: number, now = Date.now()): Promise<{ removed: number; freed: number }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { removed: 0, freed: 0 };
  }
  const entries: { path: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      entries.push({ path, mtime: (await lstat(path)).mtimeMs, size: await sizeOf(path) });
    } catch {
      // vanished while listing
    }
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  let removed = 0;
  let freed = 0;
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (now - e.mtime < KEEP_RECENT_MS) break; // sorted: everything after is newer
    await rm(e.path, { recursive: true, force: true });
    total -= e.size;
    freed += e.size;
    removed++;
  }
  return { removed, freed };
}
