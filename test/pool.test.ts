import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/util/pool.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("keeps the result order of the input", async () => {
    const out = await mapLimit([30, 5, 15, 1], 3, async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` jobs at once", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
    });
    expect(peak).toBe(3);
  });

  it("limit 1 runs one after another", async () => {
    const order: string[] = [];
    await mapLimit(["a", "b", "c"], 1, async (x) => {
      order.push(`start ${x}`);
      await sleep(2);
      order.push(`end ${x}`);
    });
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("rejects with the first error and starts no new jobs after it", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        await sleep(2);
        if (n === 1) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });
});
