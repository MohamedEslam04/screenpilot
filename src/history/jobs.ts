import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheHome } from "../brand.js";
import { NO_HISTORY_ENV } from "./index.js";

/** What a running render tells the dashboard (one small file per job, gone when it ends). */
export interface JobInfo {
  id: string;
  pid: number;
  kind: "render" | "sequence";
  /** The storyboard or sequence being rendered. */
  path: string;
  quality?: string;
  startedAt: string;
  updatedAt: string;
  /** Progress, when the work knows it: chunk i of n, or part i of n. */
  step?: { label: string; index: number; total: number };
}

export function jobsDir(): string {
  return join(cacheHome(), "jobs");
}

export interface Job {
  update(step: JobInfo["step"]): void;
  end(): void;
}

const noop: Job = { update() {}, end() {} };

/** Announce a running job. Never throws, and writes are synchronous so `end` also works from an exit handler. */
export function startJob(info: Pick<JobInfo, "kind" | "path" | "quality">, dir?: string): Job {
  if (!dir && process.env[NO_HISTORY_ENV]) return noop;
  dir ??= jobsDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return noop;
  }
  const id = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const file = join(dir, `${id}.json`);
  const state: JobInfo = { id, pid: process.pid, ...info, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const write = () => {
    try {
      state.updatedAt = new Date().toISOString();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
    } catch {
      // ignored on purpose
    }
  };
  const end = () => {
    process.off("exit", end);
    try {
      rmSync(file, { force: true });
    } catch {
      // ignored on purpose
    }
  };
  process.on("exit", end);
  write();
  return {
    update(step) {
      state.step = step;
      write();
    },
    end,
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The jobs running now. A file whose process is gone (a crash) is removed. */
export function listJobs(dir = jobsDir()): JobInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const jobs: JobInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const job = JSON.parse(readFileSync(file, "utf8")) as JobInfo;
      if (alive(job.pid)) jobs.push(job);
      else rmSync(file, { force: true });
    } catch {
      // being written, or not ours
    }
  }
  return jobs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
