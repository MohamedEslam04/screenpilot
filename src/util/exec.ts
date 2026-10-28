import { spawn } from "node:child_process";

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

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {}); // the child may exit before reading everything
      child.stdin!.end(opts.input);
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
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
      reject(new Error(`${cmd}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}\n${stderr.trim().split("\n").slice(-15).join("\n")}`));
    });
  });
}
