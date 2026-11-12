// Shared by the cloud voice providers: a fetch that retries what is worth retrying and
// whose errors never contain the API key (the key is also redacted from the service's reply).

/** Delay before a retry grows with the attempt number; tests set it to 0. */
export const retry = { delayMs: 800, /** longest wait asked for by a Retry-After header */ maxWaitMs: 10_000 };

const TRIES = 3;
const TIMEOUT_MS = 60_000;

/** A header a gateway may echo back in an error page, with its value. */
const SECRET_HEADER = /\b(xi-api-key|x-goog-api-key|api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}&]+/gi;

export function redact(text: string, secret: string): string {
  const plain = secret ? text.replaceAll(secret, "***") : text;
  return plain.replace(SECRET_HEADER, "$1$2***");
}

export interface FetchOptions {
  /** True when the status and reply mean a retry cannot help (e.g. out of credits). Overrides the default rule. */
  fatal?: (status: number, body: string) => boolean;
  /** A sentence added after the failure to say what the user can do. Gets the redacted reply text. */
  hint?: (status: number, body: string) => string | undefined;
}

/** Seconds from a Retry-After header (a number or a date) as milliseconds, capped; 0 when absent. */
function retryAfterMs(res: Response): number {
  const v = res.headers.get("retry-after");
  if (!v) return 0;
  const ms = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, retry.maxWaitMs) : 0;
}

/**
 * Send a request, retrying network errors, 429 and 5xx up to 3 tries in total.
 * Any other error status fails at once. Resolves with an OK response only.
 */
export async function fetchWithRetry(label: string, secret: string, url: string, init: RequestInit, opts: FetchOptions = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    let retryable: boolean;
    let waitMs = 0;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      const body = redact((await res.text().catch(() => "")).trim().slice(0, 300), secret);
      const hint = opts.hint?.(res.status, body);
      failure = `${label} answered ${res.status}${body ? `: ${body}` : ""}${hint ? ` (${hint})` : ""}`;
      retryable = (res.status === 429 || res.status >= 500) && !opts.fatal?.(res.status, body);
      waitMs = retryAfterMs(res);
    } catch (err) {
      failure = `${label} could not be reached: ${redact((err as Error).message, secret)}`;
      retryable = true;
    }
    if (!retryable || attempt >= TRIES) throw new Error(failure);
    const base = retry.delayMs * attempt;
    await new Promise((r) => setTimeout(r, Math.max(base, waitMs) + Math.random() * base * 0.25));
  }
}

/**
 * Check that an OK reply is the kind of content expected (`audio/` for speech). A gateway or
 * login page in front of a wrong base URL answers 200 with HTML, which must not be saved as audio.
 * A reply without a content-type is let through: the caller still checks it has a body.
 */
export async function expectContentType(label: string, res: Response, secret: string, prefix: string, hint?: string): Promise<void> {
  const type = res.headers.get("content-type");
  if (!type || type.toLowerCase().startsWith(prefix) || type.toLowerCase().startsWith("application/octet-stream")) return;
  const body = redact((await res.text().catch(() => "")).trim().replace(/\s+/g, " ").slice(0, 120), secret);
  throw new Error(`${label} answered 200 but the reply is not ${prefix.replace(/\/$/, "")} (content-type ${type})${body ? `: ${body}` : ""}${hint ? ` (${hint})` : ""}`);
}

/** Read an OK reply as JSON; say what came back when it is not JSON (HTML from a gateway, an empty body). */
export async function readJson<T>(label: string, res: Response, secret: string, hint?: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const body = redact(text.trim().replace(/\s+/g, " ").slice(0, 120), secret);
    throw new Error(`${label} answered 200 but the reply is not JSON${body ? `: ${body}` : " (empty)"}${hint ? ` (${hint})` : ""}`);
  }
}
