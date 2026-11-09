import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { freemem } from "node:os";

// Memory for long renders: how much is really available before a part or chunk
// starts (each one starts several headless Chromes), and how much the render's
// child processes used at their peak.

const MB = 1024 * 1024;

/** Default free memory a part or chunk waits for (MB). */
export const DEFAULT_MIN_FREE_MEM_MB = 1500;
/** Default longest wait for it (s). */
export const DEFAULT_MEM_TIMEOUT_S = 300;
/** Sets the default of --min-free-mem (MB); 0 turns the guard off. */
export const MIN_FREE_MEM_ENV = "SCREENPILOT_MIN_FREE_MEM";

/** Memory guard options shared by renders and sequences. */
export interface MemGuardOptions {
  /** Wait before each part or chunk until this much memory is available (MB, `--min-free-mem`). Default 1500; 0 turns it off. */
  minFreeMemMB?: number;
  /** Longest wait for it (s, `--mem-timeout`), then the render fails with the numbers. Default 300. */
  memTimeoutS?: number;
  /** Reads the available memory in bytes (tests inject one). Default readAvailableMemory. */
  memReader?: () => Promise<number>;
  /** How often to look again while waiting (ms). Default 2000. */
  memPollMs?: number;
}

/** /proc/meminfo: MemAvailable (what the kernel says a new program can get without swapping), else free + buffers + page cache. */
export function parseMemInfo(text: string): { availableBytes: number; totalBytes?: number } | undefined {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  const free = kb("MemFree");
  const availableBytes = available ?? (free === undefined ? undefined : free + (kb("Buffers") ?? 0) + (kb("Cached") ?? 0));
  if (availableBytes === undefined) return undefined;
  return { availableBytes, ...(total !== undefined ? { totalBytes: total } : {}) };
}

/** macOS `vm_stat`: free, inactive, speculative and purgeable pages can all be handed to a new program. */
export function parseVmStat(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text);
  const pages = (name: string) => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const free = pages("free");
  if (!size || free === undefined) return undefined;
  return (free + (pages("inactive") ?? 0) + (pages("speculative") ?? 0) + (pages("purgeable") ?? 0)) * Number(size[1]);
}

const output = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(cmd, args, { timeout: 5000, maxBuffer: 16 * MB }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

/**
 * Memory available to a new program, in bytes. os.freemem is not enough on Linux
 * (it leaves out the page cache the kernel gives back on demand), so Linux reads
 * MemAvailable, macOS vm_stat; Windows (and any failure) uses os.freemem.
 */
export async function readAvailableMemory(platform: NodeJS.Platform = process.platform): Promise<number> {
  try {
    if (platform === "linux") {
      const r = parseMemInfo(await readFile("/proc/meminfo", "utf8"));
      if (r) return r.availableBytes;
    } else if (platform === "darwin") {
      const r = parseVmStat(await output("vm_stat", []));
      if (r !== undefined) return r;
    }
  } catch {
    // fall back below
  }
  return freemem();
}

/** The guard as configured: options first, then SCREENPILOT_MIN_FREE_MEM, then the defaults. */
export function memGuardSettings(opts: Pick<MemGuardOptions, "minFreeMemMB" | "memTimeoutS">, env: NodeJS.ProcessEnv = process.env): { minBytes: number; timeoutMs: number } {
  const check = (v: number, what: string) => {
    if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${what} "${v}": use a number of 0 or more`);
    return v;
  };
  const fromEnv = env[MIN_FREE_MEM_ENV];
  const envMB = fromEnv === undefined || fromEnv.trim() === "" ? undefined : check(Number(fromEnv), MIN_FREE_MEM_ENV);
  const minMB = opts.minFreeMemMB === undefined ? (envMB ?? DEFAULT_MIN_FREE_MEM_MB) : check(opts.minFreeMemMB, "--min-free-mem");
  const timeoutS = opts.memTimeoutS === undefined ? DEFAULT_MEM_TIMEOUT_S : check(opts.memTimeoutS, "--mem-timeout");
  return { minBytes: minMB * MB, timeoutMs: timeoutS * 1000 };
}

/** Not enough memory came back within the timeout. */
export class MemoryGuardError extends Error {
  constructor(
    message: string,
    readonly availableMB: number,
    readonly neededMB: number,
    readonly waitedSeconds: number,
  ) {
    super(message);
    this.name = "MemoryGuardError";
  }
}

const mb = (bytes: number) => Math.round(bytes / MB);

/**
 * Wait until `minBytes` are available, looking every `pollMs`, for at most
 * `timeoutMs`; then fail with the numbers. Never waits longer than the timeout
 * (plus one poll), and a reader that fails or returns nonsense fails at once.
 */
export async function waitForMemory(o: {
  minBytes: number;
  timeoutMs: number;
  /** What is about to start, for messages ("part 2/8"). */
  label: string;
  read?: () => Promise<number>;
  pollMs?: number;
  log?: (msg: string) => void;
}): Promise<{ availableBytes: number; waitedMs: number }> {
  if (!(o.minBytes > 0)) return { availableBytes: Number.NaN, waitedMs: 0 };
  const read = o.read ?? (() => readAvailableMemory());
  const pollMs = o.pollMs ?? 2000;
  const started = Date.now();
  let logged = false;
  for (;;) {
    const available = await read();
    if (!Number.isFinite(available) || available < 0) throw new Error(`${o.label}: could not read free memory (got ${available}); pass --min-free-mem 0 to turn the check off`);
    const waited = Date.now() - started;
    if (available >= o.minBytes) return { availableBytes: available, waitedMs: logged ? waited : 0 };
    if (waited >= o.timeoutMs) {
      const s = Math.round(waited / 100) / 10;
      throw new MemoryGuardError(
        `${o.label}: not enough free memory: ${mb(available)} MB available, need ${mb(o.minBytes)} MB (waited ${s} s). ` +
          "Close other programs, lower --workers, or set --min-free-mem / --mem-timeout. Finished parts and chunks are kept.",
        mb(available),
        mb(o.minBytes),
        s,
      );
    }
    if (!logged) {
      o.log?.(`${o.label}: waiting for memory: ${mb(available)} MB available, need ${mb(o.minBytes)} MB (up to ${Math.round(o.timeoutMs / 1000)} s)`);
      logged = true;
    }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, o.timeoutMs - waited))));
  }
}

/** Sum the resident memory of every descendant of `root` from a pid -> {ppid, rss} table. */
function sumDescendants(procs: Map<number, { ppid: number; rss: number }>, root: number): number {
  const children = new Map<number, number[]>();
  for (const [pid, p] of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
  let total = 0;
  const stack = [...(children.get(root) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += procs.get(pid)?.rss ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

async function linuxProcs(): Promise<Map<number, { ppid: number; rss: number }>> {
  const procs = new Map<number, { ppid: number; rss: number }>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      const ppid = /^PPid:\s+(\d+)/m.exec(status);
      const rss = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
      if (ppid) procs.set(Number(name), { ppid: Number(ppid[1]), rss: rss ? Number(rss[1]) * 1024 : 0 });
    } catch {
      // the process ended while we looked
    }
  }
  return procs;
}

async function psProcs(): Promise<Map<number, { ppid: number; rss: number }>> {
  const procs = new Map<number, { ppid: number; rss: number }>();
  for (const line of (await output("ps", ["-A", "-o", "pid=,ppid=,rss="])).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) * 1024 });
  }
  return procs;
}

/**
 * Resident memory of all descendants of `root` (default this process), in bytes:
 * the HyperFrames node, its Chromes and ffmpeg during a render. Linux reads /proc,
 * macOS and other Unixes `ps`; undefined on Windows or when it cannot be read.
 */
export async function childRssBytes(root = process.pid, platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
  try {
    if (platform === "win32") return undefined;
    return sumDescendants(platform === "linux" ? await linuxProcs() : await psProcs(), root);
  } catch {
    return undefined;
  }
}

/**
 * Sample the children's memory every `intervalMs` (default 2 s) until stop(), which
 * gives the peak in MB, or undefined when no sample could be taken. Best effort:
 * it never throws and never keeps the process alive.
 */
export function startRssSampler(o: { intervalMs?: number; sample?: () => Promise<number | undefined> } = {}): { stop(): Promise<number | undefined> } {
  const sample = o.sample ?? (() => childRssBytes());
  let peak: number | undefined;
  let busy: Promise<void> = Promise.resolve();
  let running = false;
  const take = () => {
    if (running) return;
    running = true;
    busy = sample()
      .then((v) => {
        if (v !== undefined && Number.isFinite(v)) peak = Math.max(peak ?? 0, v);
      }, () => {})
      .finally(() => (running = false));
  };
  take();
  const timer = setInterval(take, o.intervalMs ?? 2000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await busy;
      return peak === undefined ? undefined : mb(peak);
    },
  };
}
