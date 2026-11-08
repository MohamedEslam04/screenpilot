import { describe, expect, it } from "vitest";
import { StepSchema, TakeSchema } from "../src/take/schema.js";
import { windowMatches } from "../src/take/windows.js";
import type { WindowInfo } from "../src/platform/types.js";

const win = (o: Partial<WindowInfo>): WindowInfo => ({
  id: "w",
  caption: "",
  resourceClass: "",
  pid: 1,
  active: false,
  minimized: false,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  output: "eDP-1",
  ...o,
});

describe("windowMatches", () => {
  it("returns every window with the same caption and a different pid", () => {
    const wins = [
      win({ id: "a", caption: "Safha Archive", resourceClass: "brave-browser", pid: 10 }),
      win({ id: "b", caption: "Safha Archive", resourceClass: "brave-browser", pid: 20, active: true }),
      win({ id: "c", caption: "Konsole", resourceClass: "konsole", pid: 30 }),
    ];
    expect(windowMatches(wins, "Safha Archive").map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("prefers the app class over the caption, case-insensitively", () => {
    const wins = [win({ id: "a", caption: "konsole notes", resourceClass: "dolphin" }), win({ id: "b", resourceClass: "org.kde.Konsole" })];
    expect(windowMatches(wins, "KONSOLE").map((w) => w.id)).toEqual(["b"]);
  });

  it("falls back to the caption and returns nothing when nothing matches", () => {
    const wins = [win({ id: "a", caption: "Receipt.pdf", resourceClass: "okular" })];
    expect(windowMatches(wins, "receipt").map((w) => w.id)).toEqual(["a"]);
    expect(windowMatches(wins, "nothing")).toEqual([]);
  });
});

describe("focus step schema", () => {
  it("parses a match, with or without a screen", () => {
    expect(StepSchema.safeParse({ focus: { match: "receipt", screen: "eDP-1" } }).success).toBe(true);
    expect(StepSchema.safeParse({ focus: { match: "receipt" } }).success).toBe(true);
  });

  it("parses browser: true, with or without a screen", () => {
    expect(StepSchema.safeParse({ focus: { browser: true } }).success).toBe(true);
    expect(StepSchema.safeParse({ focus: { browser: true, screen: "eDP-1" } }).success).toBe(true);
  });

  it("rejects browser and match together", () => {
    expect(StepSchema.safeParse({ focus: { browser: true, match: "Safha Archive" } }).success).toBe(false);
  });

  it("rejects a focus with neither", () => {
    expect(StepSchema.safeParse({ focus: {} }).success).toBe(false);
    expect(StepSchema.safeParse({ focus: { screen: "eDP-1" } }).success).toBe(false);
  });

  it("rejects browser: false", () => {
    expect(StepSchema.safeParse({ focus: { browser: false } }).success).toBe(false);
  });

  it("works inside a take", () => {
    expect(TakeSchema.safeParse({ steps: [{ focus: { browser: true } }] }).success).toBe(true);
  });
});
