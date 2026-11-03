import { APP } from "../brand.js";
import type { Answers } from "./questions.js";

/** Set to 1 for unattended runs (CI, scripts) that have no user to ask. */
export const SKIP_BRIEF_ENV = `${APP.toUpperCase()}_SKIP_BRIEF`;

let decided: Answers | undefined;

export function rememberBrief(answers: Answers): void {
  decided = { ...answers };
}

export function briefAnswers(): Answers | undefined {
  return decided;
}

export function resetBrief(): void {
  decided = undefined;
}

/**
 * Refuse a tool that records, drives the desktop or renders until the user's
 * decisions are in. The error is written for the agent that called the tool.
 */
export function requireBrief(tool: string): void {
  if (decided || process.env[SKIP_BRIEF_ENV] === "1") return;
  throw new Error(
    `"${tool}" needs the user's decisions first. Call the "brief" tool: it shows the user the questions as option pickers (or returns them for you to ask with your question tool, ` +
      `then call "brief" again with the answers). Do not answer for the user, and skip nothing they have not already told you. ` +
      `For unattended runs set ${SKIP_BRIEF_ENV}=1.`,
  );
}
