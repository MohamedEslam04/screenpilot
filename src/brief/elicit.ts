import { applyAnswers, type Answers, type Brief, type BriefQuestion, nextBatch } from "./questions.js";

// Ask the user the brief through the MCP client's own form (elicitation):
// each choice is an option list the user picks from.

interface FormProperty {
  type: "string";
  title: string;
  description: string;
  oneOf?: { const: string; title: string }[];
  default?: string;
  minLength?: number;
}

export interface ElicitRequest {
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, FormProperty>; required: string[] };
}

export type Elicit = (req: ElicitRequest) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;

export type ElicitOutcome = { status: "confirmed"; answers: Answers } | { status: "declined"; answers: Answers };

function property(q: BriefQuestion): FormProperty {
  if (q.kind === "text") return { type: "string", title: q.header, description: q.question, minLength: 1 };
  const rec = q.options.find((o) => o.recommended);
  return {
    type: "string",
    title: q.header,
    description: `${q.question}\n${q.options.map((o) => `- ${o.label}: ${o.description}`).join("\n")}`,
    oneOf: q.options.map((o) => ({ const: o.value, title: o.recommended ? `${o.label} (Recommended)` : o.label })),
    ...(rec ? { default: rec.value } : {}),
  };
}

const MAX_FORMS = 12;

export async function elicitBrief(brief: Brief, elicit: Elicit, start: Answers = {}): Promise<ElicitOutcome> {
  let answers = start;
  for (let i = 0; i < MAX_FORMS; i++) {
    const batch = nextBatch(brief, answers);
    if (batch.length === 0) return { status: "confirmed", answers };
    const res = await elicit({
      message: "Before anything is recorded or built, choose how this video should be made. Nothing starts until you answer.",
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(batch.map((q) => [q.id, property(q)])),
        required: batch.map((q) => q.id),
      },
    });
    if (res.action !== "accept") return { status: "declined", answers };
    const given = Object.fromEntries(Object.entries(res.content ?? {}).map(([k, v]) => [k, String(v ?? "")]));
    answers = applyAnswers(brief, answers, given).answers;
  }
  return { status: nextBatch(brief, answers).length === 0 ? "confirmed" : "declined", answers };
}
