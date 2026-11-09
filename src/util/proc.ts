import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// Abort for long jobs (renders): every child `run` starts inside a process scope
// is tracked, and on POSIX gets its own process group (detached), so one signal
// to the group reaches it and everything it started. Abort, an AbortSignal, and
// SIGINT/SIGTERM/SIGHUP of this process kill every tracked tree: SIGTERM, then
// SIGKILL after the grace period. Some descendants start their own group (puppeteer
// starts Chrome detached), so the tree is also walked through the process table.
// Windows has no process groups: `taskkill /T /F` ends the tree by parent PID.

/** Seconds a tree gets to exit after SIGTERM before SIGKILL. SCREENPILOT_KILL_GRACE_MS overrides it (tests). */
export const KILL_GRACE_MS = 5000;

const defaultGrace = () => {
  const ms = Number(process.env.SCREENPILOT_KILL_GRACE_MS);
  return Number.isFinite(ms) && ms >= 0 ? ms : KILL_GRACE_MS;
};

/** Thrown by `run` (and so by the render) when its scope was aborted. */
export class AbortedError extends Error {
  constructor(reason: string) {
    super(`render aborted: ${reason}`);
    this.name = "AbortedError";
  }
}

/** Runs a command; injected in tests (Windows cannot be run here). */
export type CommandRunner = (cmd: string, args: string[]) => Promise<void>;

export interface KillOptions {
  /** Milliseconds between SIGTERM and SIGKILL (POSIX). Default KILL_GRACE_MS. */
  graceMs?: number;
  platform?: NodeJS.Platform;
  /** Windows: runs taskkill. */
  runner?: CommandRunner;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
}

/** One line of /proc/<pid>/stat. The command name is in parentheses and may hold spaces and parentheses itself. */
export function parseProcStat(line: string): ProcInfo | undefined {
  const close = line.lastIndexOf(")");
  const pid = Number.parseInt(line, 10);
  if (close < 0 || !Number.isInteger(pid)) return undefined;
  const [state, ppid, pgid] = line.slice(close + 1).trim().split(/\s+/);
  if (ppid === undefined || pgid === undefined) return undefined;
  return { pid, ppid: Number(ppid), pgid: Number(pgid), zombie: state === "Z" };
}

/** Output of `ps -A -o pid=,ppid=,pgid=,stat=`. */
export function parsePs(text: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of text.split("\n")) {
    const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
    if (!pid || !ppid || !pgid) continue;
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: (stat ?? "").startsWith("Z") });
  }
  return table;
}

/** Every process on the machine (POSIX), empty when it cannot be read. Synchronous, so it also works in an exit handler. */
export function listProcesses(platform: NodeJS.Platform = process.platform): Map<number, ProcInfo> {
  if (platform === "linux") {
    const table = new Map<number, ProcInfo>();
    try {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const info = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
          if (info) table.set(info.pid, info);
        } catch {
          // gone meanwhile
        }
      }
    } catch {}
    return table;
  }
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" });
  return r.status === 0 ? parsePs(r.stdout) : new Map();
}

/**
 * `root` and all its descendants, and the process groups they are in, except
 * `ownGroup` (ours: signalling it would kill this process). A root missing from the
 * table (it could not be read) still counts as the leader of its own group, as
 * every scoped child is started detached.
 */
export function treeOf(root: number, table: Map<number, ProcInfo>, ownGroup: number): { pids: Set<number>; groups: Set<number> } {
  const children = new Map<number, number[]>();
  for (const p of table.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const pids = new Set<number>([root]);
  const queue = [root];
  while (queue.length) for (const c of children.get(queue.shift()!) ?? []) if (!pids.has(c)) pids.add(c), queue.push(c);
  const groups = new Set<number>();
  for (const pid of pids) {
    const pgid = table.get(pid)?.pgid ?? (pid === root ? root : undefined);
    if (pgid !== undefined && pgid > 1 && pgid !== ownGroup) groups.add(pgid);
  }
  return { pids, groups };
}

/** Our own process group, read from the table (0 when unknown, which matches no real group). */
const ownGroup = (table: Map<number, ProcInfo>) => table.get(process.pid)?.pgid ?? 0;

/** Whether `pid` is running. A zombie (exited, not reaped yet) is not. */
export function processAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      return !parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.zombie;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalTree(tree: { pids: Set<number>; groups: Set<number> }, sig: NodeJS.Signals): void {
  for (const g of tree.groups) {
    try {
      process.kill(-g, sig);
    } catch {}
  }
  for (const pid of tree.pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

const runTaskkill: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill `pid` and everything it started. POSIX: SIGTERM to every process of the
 * tree and to its process groups, wait up to the grace period, then SIGKILL what
 * is left (the tree is read again first, to catch anything started meanwhile).
 * Windows: `taskkill /PID <pid> /T /F`.
 */
export async function killTree(pid: number, opts: KillOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    await (opts.runner ?? runTaskkill)("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const table = listProcesses(platform);
  const tree = treeOf(pid, table, ownGroup(table));
  signalTree(tree, "SIGTERM");
  dying.add(tree);
  const deadline = Date.now() + (opts.graceMs ?? defaultGrace());
  try {
    while (Date.now() < deadline && [...tree.pids].some(processAlive)) await sleep(50);
  } finally {
    dying.delete(tree);
  }
  // Groups too: a process that left the tree (its parent died) keeps its group.
  const again = listProcesses(platform);
  const own = ownGroup(again);
  const left = { pids: new Set<number>(), groups: new Set<number>() };
  for (const p of tree.pids) {
    if (!processAlive(p)) continue;
    const t = treeOf(p, again, own);
    for (const x of t.pids) left.pids.add(x);
    for (const g of t.groups) left.groups.add(g);
  }
  for (const g of tree.groups) if ([...again.values()].some((p) => p.pgid === g && !p.zombie)) left.groups.add(g);
  signalTree(left, "SIGKILL");
}

/** Trees between SIGTERM and SIGKILL: an exit of this process meanwhile SIGKILLs them at once. */
const dying = new Set<{ pids: Set<number>; groups: Set<number> }>();

/** Kill a tree right now, synchronously (process exit: no time for a grace period). */
function killTreeNow(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return;
  }
  const table = listProcesses();
  signalTree(treeOf(pid, table, ownGroup(table)), "SIGKILL");
}

/** Whether children of a scope start in their own process group (POSIX only; Windows would give each a console). */
export const detachChildren = (platform: NodeJS.Platform = process.platform) => platform !== "win32";

/** The child processes of one job (a render or a sequence), killed together by abort. */
export class ProcessScope {
  readonly children = new Set<ChildProcess>();
  aborted?: AbortedError;
  private killing?: Promise<void>;
  constructor(readonly opts: KillOptions = {}) {}

  track(child: ChildProcess): void {
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    child.once("error", () => this.children.delete(child));
  }

  /** Mark the scope aborted (nothing new starts) and kill every child tree. Calling it again waits for the same kill. */
  abort(reason: string, opts: KillOptions = {}): Promise<void> {
    if (!this.aborted) {
      this.aborted = new AbortedError(reason);
      const o = { ...this.opts, ...opts };
      this.killing = Promise.all([...this.children].map((c) => (c.pid ? killTree(c.pid, o) : undefined))).then(() => {});
    }
    return this.killing!;
  }
}

const store = new AsyncLocalStorage<ProcessScope>();
const scopes = new Map<ProcessScope, Promise<unknown>>();

/** The scope the current async call chain runs in, if any. */
export const currentScope = (): ProcessScope | undefined => store.getStore();

/**
 * Run `fn` with every child process it starts through `run` tracked, so abortAll
 * (or `signal`) kills them all. A scope inside a scope joins the outer one.
 */
export async function withProcessScope<T>(fn: () => Promise<T>, opts: { signal?: AbortSignal } & KillOptions = {}): Promise<T> {
  if (currentScope()) return fn();
  const { signal, ...kill } = opts;
  const scope = new ProcessScope(kill);
  const onAbort = () => void scope.abort("the request was cancelled");
  if (signal?.aborted) scope.aborted = new AbortedError("the request was cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  const done = store.run(scope, fn);
  scopes.set(scope, done);
  if (scopes.size === 1) installHandlers();
  try {
    return await done;
  } catch (err) {
    // A child that died from the kill makes its own error; the abort is the real reason.
    // Wait for the whole tree (grandchildren that ignore SIGTERM too) before reporting it.
    if (scope.aborted) {
      await scope.abort(scope.aborted.message);
      throw scope.aborted;
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    scopes.delete(scope);
    if (scopes.size === 0) removeHandlers();
  }
}

/**
 * Abort every running scope and wait until their process trees are gone.
 * Returns how many scopes were running.
 */
export async function abortAll(reason = "aborted", opts: KillOptions = {}): Promise<number> {
  const running = [...scopes.keys()];
  await Promise.all(running.map((s) => s.abort(reason, opts)));
  return running.length;
}

// While a scope runs, this process's own exit must take the detached trees with it:
// they no longer get the terminal's Ctrl-C (it goes to our process group only).
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_NUMBER: Record<(typeof EXIT_SIGNALS)[number], number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const handlers = new Map<NodeJS.Signals, () => void>();
let exitHook = false;

function onExit(): void {
  for (const s of scopes.keys()) for (const c of s.children) if (c.pid) killTreeNow(c.pid);
  for (const tree of dying) {
    if (process.platform !== "win32") signalTree(tree, "SIGKILL");
    for (const pid of tree.pids) if (processAlive(pid)) killTreeNow(pid);
  }
}

function installHandlers(): void {
  if (!exitHook) {
    process.on("exit", onExit);
    exitHook = true;
  }
  for (const sig of EXIT_SIGNALS) {
    const handler = () => {
      const settled = Promise.allSettled([...scopes.values()]);
      void abortAll(`interrupted (${sig})`)
        .then(() => Promise.race([settled, sleep(2000)]))
        .finally(() => {
          // Another handler (the MCP server's shutdown) decides how to exit; else exit as the signal would have.
          if (process.listeners(sig).every((l) => l === handler)) process.exit(128 + SIGNAL_NUMBER[sig]);
        });
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
}

function removeHandlers(): void {
  for (const [sig, handler] of handlers) process.off(sig, handler);
  handlers.clear();
}
