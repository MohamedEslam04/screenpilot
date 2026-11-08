import { describe, expect, it } from "vitest";
import { maxWorkers, parseWorkers } from "../src/render/workers.js";

const GB = 1024 ** 3;

describe("maxWorkers", () => {
  it("leaves two cores free and is limited by memory", () => {
    expect(maxWorkers(12, 32 * GB)).toBe(10);
    // (15 - 1) / 1.5 = 9 workers fit in memory, fewer than the 10 cores allow
    expect(maxWorkers(12, 15 * GB)).toBe(9);
  });

  it("is capped at 12", () => {
    expect(maxWorkers(64, 128 * GB)).toBe(12);
  });

  it("never goes below one and never exceeds what memory allows", () => {
    expect(maxWorkers(4, 0)).toBe(1);
    expect(maxWorkers(1, 32 * GB)).toBe(1);
    expect(maxWorkers(2, 32 * GB)).toBe(1);
    expect(maxWorkers(12, 4 * GB)).toBe(2);
  });
});

describe("parseWorkers", () => {
  it("returns undefined (auto) without a value or variable", () => {
    expect(parseWorkers(undefined, {})).toBeUndefined();
    expect(parseWorkers("auto", {})).toBeUndefined();
    expect(parseWorkers("", {})).toBeUndefined();
  });

  it("max returns maxWorkers()", () => {
    expect(parseWorkers("max", {})).toBe(maxWorkers());
  });

  it("accepts a positive integer as string or number", () => {
    expect(parseWorkers("3", {})).toBe(3);
    expect(parseWorkers(4, {})).toBe(4);
  });

  it("rejects anything else and names the accepted values", () => {
    for (const bad of ["0", "-2", "many", "2.5", 0, 1.5, Number.NaN]) {
      expect(() => parseWorkers(bad, {})).toThrow(/auto.*max/);
    }
  });

  it("falls back to SCREENPILOT_WORKERS", () => {
    expect(parseWorkers(undefined, { SCREENPILOT_WORKERS: "5" })).toBe(5);
    expect(parseWorkers("auto", { SCREENPILOT_WORKERS: "5" })).toBe(5);
    expect(parseWorkers(undefined, { SCREENPILOT_WORKERS: "max" })).toBe(maxWorkers());
    expect(parseWorkers(undefined, { SCREENPILOT_WORKERS: "auto" })).toBeUndefined();
  });

  it("lets the flag win over the variable", () => {
    expect(parseWorkers("2", { SCREENPILOT_WORKERS: "5" })).toBe(2);
    expect(parseWorkers("max", { SCREENPILOT_WORKERS: "5" })).toBe(maxWorkers());
  });

  it("rejects a bad variable", () => {
    expect(() => parseWorkers(undefined, { SCREENPILOT_WORKERS: "lots" })).toThrow(/SCREENPILOT_WORKERS/);
  });
});
