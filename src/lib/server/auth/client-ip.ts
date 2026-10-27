import "server-only";
import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

const FALLBACK = "unknown";

/** The client address as the platform proxy reports it, or undefined when no header carries one. */
export function clientIpFrom(headers: Pick<Headers, "get">): string | undefined {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : undefined;
}

/** Expands an IPv6 address (no zone, no embedded IPv4 tail) to eight 16-bit groups, or null. */
function expandV6(addr: string): number[] | null {
  const [head = "", tail, extra] = addr.split("::");
  if (extra !== undefined) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...t].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/**
 * The key an address is limited under: IPv4 as is, IPv4-mapped IPv6 as its IPv4, other IPv6 as its /64 (one subscriber can
 * rotate through the whole /64). Anything that is not a valid address (malformed, bracketed, leading zeros) shares the
 * FALLBACK bucket, so a forged header value cannot mint buckets.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase().split("%")[0] ?? "";
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return FALLBACK;
  const mapped = ip.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  let v6 = ip;
  const tail = ip.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail?.[1]) {
    const o = tail[1].split(".").map(Number);
    v6 = ip.slice(0, ip.length - tail[1].length) + (((o[0]! << 8) | o[1]!).toString(16)) + ":" + (((o[2]! << 8) | o[3]!).toString(16));
  }
  const groups = expandV6(v6);
  if (!groups) return FALLBACK;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** A one-way key for rate-limit rows; the raw address is never stored. Requests without an address share one bucket. */
export function clientIpHash(headers: Pick<Headers, "get">): string {
  const raw = clientIpFrom(headers);
  const ip = raw ? normalizeIp(raw) : FALLBACK;
  return createHash("sha256").update(`noteprep:ip:v1:${ip}`).digest("hex").slice(0, 32);
}
