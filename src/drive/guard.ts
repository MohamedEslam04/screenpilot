import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ALLOW_APPS_ENV, ALLOW_ENV_ENV, configDir } from "../brand.js";
import type { Desktop } from "../platform/types.js";

// Opt-in limits for agents that drive the desktop unattended. Unset means no limit
// (the default), so nothing changes for people who sit at the machine.

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Throw unless `name` may be typed from the environment. */
export function checkEnvAllowed(name: string, env: NodeJS.ProcessEnv = process.env): void {
  const allowed = list(env[ALLOW_ENV_ENV]);
  if (allowed.length && !allowed.includes(name)) throw new Error(`env var ${name} is not allowed (${ALLOW_ENV_ENV} lists: ${allowed.join(", ")})`);
}

/** Throw unless the focused window belongs to an allowed app. No-op when no list is set. */
export async function checkAppAllowed(desktop: Pick<Desktop, "listWindows" | "windowControl">, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const allowed = list(env[ALLOW_APPS_ENV]).map((a) => a.toLowerCase());
  if (!allowed.length) return;
  if (!desktop.windowControl) throw new Error(`${ALLOW_APPS_ENV} is set but this desktop cannot tell which window is focused`);
  const active = (await desktop.listWindows()).find((w) => w.active);
  const names = active ? [active.resourceClass, active.caption].map((n) => n.toLowerCase()) : [];
  if (!allowed.some((a) => names.some((n) => n.includes(a)))) {
    throw new Error(`The focused window (${active?.resourceClass ?? "none"}) is not an allowed app (${ALLOW_APPS_ENV}: ${allowed.join(", ")}). Focus one with focus_window first.`);
  }
}

export function auditPath(): string {
  return join(configDir(), "audit.jsonl");
}

/** One JSON line per action the agent took. Never logs typed text, only its length. */
export async function audit(tool: string, args: unknown, file = auditPath()): Promise<void> {
  const a = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
  if ("text" in a) a.text = typeof a.text === "string" ? { chars: [...a.text].length } : a.text;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), tool, args: a })}\n`);
  } catch {
    // the log must never stop a take
  }
}
