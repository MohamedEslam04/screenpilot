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
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (opts.inherit) process.stderr.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      if (opts.inherit) process.stderr.write(d);
    });
    child.on("error", (err) => reject(new Error(`${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}\n${stderr.trim().split("\n").slice(-15).join("\n")}`));
    });
  });
}
