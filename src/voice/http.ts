// Shared by the cloud voice providers: a fetch that retries what is worth retrying and
// whose errors never contain the API key (the key is also redacted from the service's reply).

/** Delay before a retry grows with the attempt number; tests set it to 0. */
export const retry = { delayMs: 800 };

const TRIES = 3;
const TIMEOUT_MS = 60_000;

function redact(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, "***") : text;
}

/**
 * Send a request, retrying network errors, 429 and 5xx up to 3 tries in total.
 * Any other error status fails at once. Resolves with an OK response only.
 */
export async function fetchWithRetry(label: string, secret: string, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    let retryable: boolean;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      const detail = redact((await res.text().catch(() => "")).trim().slice(0, 300), secret);
      failure = `${label} answered ${res.status}${detail ? `: ${detail}` : ""}`;
      retryable = res.status === 429 || res.status >= 500;
    } catch (err) {
      failure = `${label} could not be reached: ${redact((err as Error).message, secret)}`;
      retryable = true;
    }
    if (!retryable || attempt >= TRIES) throw new Error(failure);
    await new Promise((r) => setTimeout(r, retry.delayMs * attempt));
  }
}
