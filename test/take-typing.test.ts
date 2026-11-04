import { describe, expect, it } from "vitest";
import { typingSpan } from "../src/take/typing.js";

describe("typingSpan", () => {
  it("marks when a literal type step ran, with its text", () => {
    expect(typingSpan({ type: "hello" }, 4.2, 6.7)).toEqual({ at: 4.2, dur: 2.5, text: "hello" });
  });

  it("keeps the text out for a secret from an env var, so it can never reach the storyboard", () => {
    const span = typingSpan({ type: { env: "PASSWORD" } }, 10, 11.5);
    expect(span).toEqual({ at: 10, dur: 1.5 });
    expect(span).not.toHaveProperty("text");
  });

  it("never makes a span shorter than 0.2 s", () => {
    expect(typingSpan({ type: "a" }, 1, 1.01)).toEqual({ at: 1, dur: 0.2, text: "a" });
  });

  it("rounds to milliseconds", () => {
    expect(typingSpan({ type: "ab" }, 1.23456, 3.98765)).toEqual({ at: 1.235, dur: 2.753, text: "ab" });
  });
});
