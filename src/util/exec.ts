import { spawn } from "node:child_process";
import { currentScope, detachChildren, killTree } from "./proc.js";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stream child output to our stderr (stdout is reserved for MCP / JSON). */
  inherit?: boolean;
  /** Written to the child's stdin, then closed. Without it stdin is closed at once. */
  input?: string;
  /** Kill the child and fail after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Run a command and collect its output. Inside a process scope (a render, see
 * withProcessScope) the child is tracked and, on POSIX, gets its own process group,
 * so an abort kills it and everything it started; once the scope is aborted nothing
 * new starts.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const scope = currentScope();
  if (scope?.aborted) return Promise.reject(scope.aborted);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: scope ? detachChildren() : false,
    });
    scope?.track(child);
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {}); // the child may exit before reading everything
      child.stdin!.end(opts.input);
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (scope && child.pid) void killTree(child.pid);
          else child.kill();
          reject(new Error(`${cmd} did not finish in ${Math.round(opts.timeoutMs! / 1000)} s`));
        }, opts.timeoutMs)
      : undefined;
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d;
      if (opts.inherit) process.stderr.write(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d;
      if (opts.inherit) process.stderr.write(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(scope?.aborted ?? new Error(`${cmd}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (scope?.aborted) reject(scope.aborted);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}\n${stderr.trim().split("\n").slice(-15).join("\n")}`));
    });
  });
}
