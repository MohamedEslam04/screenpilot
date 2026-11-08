import { cpus, freemem } from "node:os";

const GB = 1024 ** 3;
const MAX_WORKERS = 6;
/** One headless Chrome worker in HyperFrames needs about this much memory. */
const PER_WORKER = 1.5 * GB;
const RESERVE = 1 * GB;

/**
 * How many parallel Chrome renderers to start. Half the cores (the rest stays
 * for the desktop, OBS and browsers), limited by free memory, 1..6.
 */
export function autoWorkers(cpuCount = cpus().length, freeBytes = freemem()): number {
  const byCpu = Math.floor(cpuCount / 2);
  const byMem = Math.floor((freeBytes - RESERVE) / PER_WORKER);
  return Math.max(1, Math.min(MAX_WORKERS, byCpu, byMem));
}

const MAX_WORKERS_CAP = 12;

/**
 * The most workers worth starting when the desktop is idle: all cores but two,
 * limited by free memory, 1..12. Never more than memory allows.
 */
export function maxWorkers(cpuCount = cpus().length, freeBytes = freemem()): number {
  const byCpu = cpuCount - 2;
  const byMem = Math.floor((freeBytes - RESERVE) / PER_WORKER);
  return Math.max(1, Math.min(MAX_WORKERS_CAP, byCpu, byMem));
}

const ACCEPTED = 'Use "auto", "max" or a whole number of 1 or more';

function parseOne(value: string | number, what: string): number | undefined {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "" || v === "auto") return undefined;
    if (v === "max") return maxWorkers();
    if (/^\d+$/.test(v) && Number(v) >= 1) return Number(v);
  } else if (Number.isInteger(value) && value >= 1) {
    return value;
  }
  throw new Error(`Invalid ${what} "${value}". ${ACCEPTED}.`);
}

/**
 * Turn the --workers flag (or the MCP field) into a worker count. undefined
 * means "auto" (autoWorkers); the flag wins over SCREENPILOT_WORKERS.
 */
export function parseWorkers(value: string | number | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const fromFlag = value === undefined ? undefined : parseOne(value, "workers");
  if (fromFlag !== undefined) return fromFlag;
  const fromEnv = env.SCREENPILOT_WORKERS;
  return fromEnv === undefined ? undefined : parseOne(fromEnv, "SCREENPILOT_WORKERS");
}
