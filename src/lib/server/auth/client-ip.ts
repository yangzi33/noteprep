import "server-only";
import { createHash } from "node:crypto";

const FALLBACK = "unknown";

/** The client address as the platform proxy reports it, or undefined when no header carries one. */
export function clientIpFrom(headers: Pick<Headers, "get">): string | undefined {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : undefined;
}

/** A one-way key for rate-limit rows; the raw address is never stored. Requests without an address share one bucket. */
export function clientIpHash(headers: Pick<Headers, "get">): string {
  const ip = clientIpFrom(headers) ?? FALLBACK;
  return createHash("sha256").update(`noteprep:ip:v1:${ip}`).digest("hex").slice(0, 32);
}
