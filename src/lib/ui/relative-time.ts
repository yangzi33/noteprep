const DAY_MS = 86_400_000;
const utcDay = (date: Date) => Math.floor(date.getTime() / DAY_MS);
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** How far away an expiry is, by UTC calendar day: "expired", "today", "tomorrow" or "in N days". `now` is passed in so the result is pure. */
export function relativeExpiry(expiresAt: Date, now: Date): string {
  if (expiresAt.getTime() <= now.getTime()) return "expired";
  const days = utcDay(expiresAt) - utcDay(now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** "in 2 days (Oct 28, UTC)"; the date part is a UTC date. An expired draft reads "expired (Oct 24, UTC)". */
export function expiryPhrase(expiresAt: Date, now: Date): string {
  return `${relativeExpiry(expiresAt, now)} (${shortDate.format(expiresAt).replace(/\s/g, " ")}, UTC)`;
}
