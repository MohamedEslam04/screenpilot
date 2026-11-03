export type Timer = <T>(label: string, work: () => Promise<T>) => Promise<T>;

/**
 * Time a stage and log `time <label>: <s>s`. When disabled it only runs the
 * work, so call sites stay the same either way.
 */
export function makeTimer(enabled: boolean | undefined, log: (msg: string) => void): Timer {
  if (!enabled) return (_label, work) => work();
  return async (label, work) => {
    const start = performance.now();
    try {
      return await work();
    } finally {
      log(`time ${label}: ${((performance.now() - start) / 1000).toFixed(2)}s`);
    }
  };
}
