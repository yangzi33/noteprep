export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 2_000, capMs: 60_000 };

/**
 * Exponential backoff with jitter: min(cap, base * 2^(attempt-1)), scaled by a random factor in
 * [0.5, 1.5). `attempt` is the number of attempts already made (1 after the first failure).
 * `random` is injectable so tests are deterministic.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
  return Math.round(raw * (0.5 + random()));
}
