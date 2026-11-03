import { afterEach, describe, expect, it } from "vitest";
import { buildBrief, nextBatch } from "../src/brief/questions.js";
import { briefAnswers, resetBrief, SKIP_BRIEF_ENV, rememberBrief, requireBrief } from "../src/brief/gate.js";
import { elicitBrief, type Elicit } from "../src/brief/elicit.js";

const brief = buildBrief({ localVoice: false, commandVoices: [], desktop: { id: "kde", windowControl: true } });

afterEach(() => {
  resetBrief();
  delete process.env[SKIP_BRIEF_ENV];
});

describe("gate", () => {
  it("blocks the tool and tells the agent how to get the decisions", () => {
    expect(() => requireBrief("record_start")).toThrow(/record_start.*brief/s);
    expect(() => requireBrief("record_start")).toThrow(/do not answer for the user/i);
  });

  it("lets everything through once the decisions are recorded", () => {
    rememberBrief({ goal: "youtube" });
    expect(() => requireBrief("render")).not.toThrow();
    expect(briefAnswers()).toEqual({ goal: "youtube" });
  });

  it("can be skipped for unattended runs", () => {
    process.env[SKIP_BRIEF_ENV] = "1";
    expect(() => requireBrief("perform")).not.toThrow();
  });
});

type Req = Parameters<Elicit>[0];
const first = (req: Req) => {
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(req.requestedSchema.properties)) {
    const one = (p as { oneOf?: { const: string }[] }).oneOf;
    out[id] = one ? one[0]!.const : "something to show";
  }
  return out;
};

describe("elicitBrief", () => {
  it("shows every batch as options, follow-ups only when they apply, until all is answered", async () => {
    const asked: string[][] = [];
    const elicit: Elicit = async (req) => {
      asked.push(Object.keys(req.requestedSchema.properties));
      return { action: "accept", content: first(req) };
    };
    const r = await elicitBrief(brief, elicit);
    expect(r.status).toBe("confirmed");
    expect(asked.every((b) => b.length <= 4)).toBe(true);
    expect(asked.flat()).toContain("voice_builtin"); // first voice option is "builtin"
    expect(asked.flat()).not.toContain("voice_external");
    expect(nextBatch(brief, (r as { answers: Record<string, string> }).answers)).toEqual([]);
  });

  it("gives each question its options with their descriptions and marks the recommended one", async () => {
    let seen: Req | undefined;
    const elicit: Elicit = async (req) => {
      seen ??= req;
      return { action: "cancel" };
    };
    await elicitBrief(brief, elicit);
    const p = seen!.requestedSchema.properties.goal as { oneOf: { const: string; title: string }[]; description: string };
    expect(p.oneOf.map((o) => o.const)).toEqual(["youtube", "social-vertical", "docs", "social-square"]);
    expect(p.description).toMatch(/Landscape 1920x1080/);
    expect(seen!.message).toMatch(/before/i);
  });

  it("stops when the user declines, keeping what was answered", async () => {
    let n = 0;
    const elicit: Elicit = async (req) => (++n === 1 ? { action: "accept", content: first(req) } : { action: "decline" });
    const r = await elicitBrief(brief, elicit);
    expect(r.status).toBe("declined");
    expect(Object.keys(r.answers).length).toBeGreaterThan(0);
  });
});
