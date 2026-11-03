import { calendarDaysBetween, formatShortDate } from "@/lib/ui/timezone";

/** How far away an expiry is, by calendar day in `timeZone`: "expired", "today", "tomorrow" or "in N days". `now` is passed in so the result is pure. */
export function relativeExpiry(expiresAt: Date, now: Date, timeZone: string): string {
  if (expiresAt.getTime() <= now.getTime()) return "expired";
  const days = calendarDaysBetween(now, expiresAt, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** "in 2 days (Oct 28, EDT)"; an expired draft reads "expired (Oct 24, EDT)". */
export function expiryPhrase(expiresAt: Date, now: Date, timeZone: string): string {
  return `${relativeExpiry(expiresAt, now, timeZone)} (${formatShortDate(expiresAt, timeZone)})`;
}
