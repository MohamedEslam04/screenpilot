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
