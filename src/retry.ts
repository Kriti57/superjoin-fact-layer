/**
 * Retries a Gemini API call on transient errors (429 rate limit, 503
 * overloaded/unavailable), with exponential backoff. Free-tier Gemini
 * occasionally returns 503 "high demand" errors that clear up within
 * seconds, so a short retry loop meaningfully improves completeness
 * without masking real, permanent failures (e.g. 404 bad model name,
 * 400 malformed request) — those still throw immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 4, baseDelayMs = 1500 }: { maxAttempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status || err?.error?.code;
      const isTransient = status === 429 || status === 503 || status === "UNAVAILABLE" || status === "RESOURCE_EXHAUSTED";
      if (!isTransient || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[retry] Transient error (status ${status}), attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr;
}
