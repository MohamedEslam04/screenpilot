import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  /** Wait for the program to exit (and fail on a non-zero code or the timeout). */
  wait: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Stop the program and everything it started (own process group on POSIX). */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* group already gone */
    }
  }
  fallback();
}

/**
 * Launch a program without a shell. `wait: false` starts it detached and returns
 * at once; `wait: true` resolves on a clean exit, rejects on a non-zero exit
 * (with the end of stderr) and kills the process group when it overruns.
 */
export function runCommand(args: string[], o: RunOptions): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd) return Promise.reject(new Error("run: empty command"));

  if (!o.wait) {
    spawn(cmd, rest, { cwd: o.cwd, detached: true, stdio: "ignore", env: o.env }).unref();
    return Promise.resolve();
  }

  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, rest, { cwd: o.cwd, detached: true, stdio: ["ignore", "ignore", "pipe"], env: o.env });
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-2000);
    });
    child.on("error", (e) => settle(() => reject(new Error(`${cmd} failed to start: ${e.message}`))));
    child.on("close", (code, signal) =>
      settle(() => {
        if (code === 0) return resolvePromise();
        const tail = stderr.trim().slice(-300);
        reject(new Error(`${cmd} exited with ${code ?? signal}${tail ? `: ${tail}` : ""}`));
      }),
    );

    const timer = setTimeout(() => {
      killTree(child.pid, () => child.kill("SIGKILL"));
      settle(() => reject(new Error(`${cmd} still running after ${round(o.timeoutMs / 1000)}s`)));
    }, o.timeoutMs);
  });
}

const round = (n: number) => Math.round(n * 10) / 10;
