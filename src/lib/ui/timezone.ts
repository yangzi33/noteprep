// Display-only time zone helpers. Stored timestamps stay in UTC; only formatting uses a zone.

export const FALLBACK_TIME_ZONE = "UTC";
export const DETECTED_TZ_COOKIE = "np_tz";

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** True when Intl accepts the name as an IANA zone. Rejects offsets ("+05:00") and anything oddly shaped. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

let zoneList: readonly string[] | undefined;

/** The zones offered in the picker: Intl's canonical list plus UTC. */
export function supportedTimeZones(): readonly string[] {
  if (!zoneList) {
    const fromIntl = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    zoneList = [...new Set([FALLBACK_TIME_ZONE, ...fromIntl])].sort((a, b) => a.localeCompare(b));
  }
  return zoneList;
}

/** True only for a zone the picker offers; used before saving a preference. */
export function isSelectableTimeZone(value: unknown): value is string {
  return typeof value === "string" && supportedTimeZones().includes(value);
}

/** Saved preference first, then the browser-detected zone, then UTC. An invalid value at any step is skipped. */
export function resolveTimeZone(saved?: string | null, detected?: string | null): string {
  if (isValidTimeZone(saved)) return saved;
  if (isValidTimeZone(detected)) return detected;
  return FALLBACK_TIME_ZONE;
}

/** Plain spaces: newer ICU puts a narrow no-break space before AM/PM. */
const plain = (s: string) => s.replace(/\s/g, " ");

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  let f = dateTimeFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone });
    dateTimeFormats.set(timeZone, f);
  }
  return f;
}

const zoneNameFormats = new Map<string, Intl.DateTimeFormat>();
function zoneLabel(date: Date, timeZone: string): string {
  let f = zoneNameFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
    zoneNameFormats.set(timeZone, f);
  }
  return f.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** "Mar 5, 2026, 3:30 PM EST" (or "GMT+9" where Intl has no short name): the instant in the given zone with a short zone label. An invalid zone falls back to UTC. */
export function formatDateTime(date: Date, timeZone: string): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE;
  return `${plain(dateTimeFormat(tz).format(date))} ${zoneLabel(date, tz)}`;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
    dayFormats.set(timeZone, f);
  }
  return f;
}

/** Whole calendar days from `from` to `to` as seen in the zone (so DST days of 23 or 25 hours do not skew it). */
export function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE;
  const asUtcDay = (d: Date) => {
    const [y, m, day] = dayFormat(tz).format(d).split("-").map(Number);
    return Date.UTC(y!, m! - 1, day!) / 86_400_000;
  };
  return asUtcDay(to) - asUtcDay(from);
}

/** "Oct 28, EDT": a short date (no year; for near-term expiry phrases) with the zone label. */
export function formatShortDate(date: Date, timeZone: string): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE;
  return `${plain(new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(date))}, ${zoneLabel(date, tz)}`;
}

/** The canonical picker name for what the user typed (case-insensitive, spaces read as underscores; a bare city name works when it is unique), or null. */
export function matchTimeZone(input: string): string | null {
  const wanted = input.trim().replace(/\s+/g, "_").toLowerCase();
  if (wanted === "") return null;
  const zones = supportedTimeZones();
  const exact = zones.find((z) => z.toLowerCase() === wanted);
  if (exact) return exact;
  const byCity = zones.filter((z) => z.toLowerCase().split("/").pop() === wanted);
  return byCity.length === 1 ? byCity[0]! : null;
}

/** Zones whose name contains every word typed (case-insensitive, spaces read as underscores); all zones for an empty query. */
export function filterTimeZones(query: string, zones: readonly string[] = supportedTimeZones()): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...zones];
  return zones.filter((z) => {
    const name = z.toLowerCase();
    return words.every((w) => name.includes(w.replace(/\s+/g, "_")) || name.replace(/_/g, " ").includes(w));
  });
}
