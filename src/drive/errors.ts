// Errors that happen while turning a take/MCP target into a point, before any
// input was sent. They carry a machine-readable code and what an agent may do
// next, so it does not have to guess from the message.

export type TargetCode =
  | "ELEMENT_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "APP_NOT_FOUND"
  | "WINDOW_NOT_FOUND"
  | "A11Y_UNAVAILABLE"
  | "POSITION_UNKNOWN"
  | "TIMEOUT";

export interface Disposition {
  /** Whether any input reached the app. Target errors never send input. */
  delivery: "not_delivered" | "unknown";
  /** "safe": nothing happened, so trying again (after fixing the target or waiting) cannot double-act. */
  retry: "safe" | "unsafe" | "unknown";
}

export class TargetError extends Error implements Disposition {
  readonly delivery = "not_delivered" as const;
  readonly retry = "safe" as const;
  constructor(
    readonly code: TargetCode,
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "TargetError";
  }
}

/** code + disposition (+ candidates) of an error, when it carries them. */
export function describeError(err: unknown): (Disposition & { code?: string; candidates?: string[] }) | undefined {
  if (err instanceof TargetError) {
    return { code: err.code, delivery: err.delivery, retry: err.retry, ...(err.candidates.length ? { candidates: err.candidates } : {}) };
  }
  return undefined;
}
