/** Small HTTP helpers shared by provider adapters. Both functions are total: they never throw. */

export type ReadTextResult = { ok: true; text: string } | { ok: false; reason: "too_large" | "read_failed" };

/**
 * Reads a response body as UTF-8 text, counting BYTES. Streams the body and cancels the reader as soon as the
 * cap is exceeded, so an oversized body is never fully buffered or decoded. A missing body is empty text.
 * Invalid UTF-8 is replaced, not thrown on.
 */
export async function readTextCapped(response: Response, maxBytes: number): Promise<ReadTextResult> {
  const body = response.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "read_failed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

/**
 * Provider back-off hint in milliseconds, or undefined. `retry-after-ms` is honoured by the official OpenAI SDK
 * only (it is not in OpenAI's documented prose); `Retry-After` is documented by OpenAI in SECONDS, and the
 * standard HTTP-date form is accepted too although OpenAI does not document it. Non-negative, capped at `capMs`;
 * garbage, negative or NaN values give undefined (an HTTP date in the past gives 0).
 */
export function parseRetryAfterMs(headers: Headers, now: number, capMs = 60_000): number | undefined {
  try {
    const clamp = (ms: number): number | undefined => (Number.isFinite(ms) && ms >= 0 ? Math.min(ms, capMs) : undefined);
    const ms = headers.get("retry-after-ms")?.trim();
    if (ms && /^\d+(\.\d+)?$/.test(ms)) return clamp(Number(ms));
    const ra = headers.get("retry-after")?.trim();
    if (!ra) return undefined;
    if (/^\d+(\.\d+)?$/.test(ra)) return clamp(Number(ra) * 1000);
    if (!/[A-Za-z]/.test(ra)) return undefined; // numeric-looking garbage such as "-5" must not parse as a date
    const date = Date.parse(ra);
    if (Number.isNaN(date)) return undefined;
    return clamp(Math.max(0, date - now));
  } catch {
    return undefined;
  }
}
