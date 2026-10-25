// Pure day math for the beta daily refresh (one `daily` usage bucket per owner and UTC day).
const DAY_MS = 86_400_000;

/** Whole days since the Unix epoch in UTC; this is the `period_key` of a daily bucket. */
export function utcDayNumber(now: Date): bigint {
  return BigInt(Math.floor(now.getTime() / DAY_MS));
}

/** The half-open UTC interval [startsAt, endsAt) of a day number. */
export function utcDayWindow(day: bigint): { startsAt: Date; endsAt: Date } {
  const start = Number(day) * DAY_MS;
  return { startsAt: new Date(start), endsAt: new Date(start + DAY_MS) };
}

/** Lifetime generations left: the trial remainder minus what the daily bucket has used or reserved, never negative. */
export function lifetimeRemaining(
  trial: { limit: number; used: number; reserved: number },
  daily: { used: number; reserved: number },
): number {
  return Math.max(0, trial.limit - trial.used - trial.reserved - daily.used - daily.reserved);
}
