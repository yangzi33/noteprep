import "server-only";
import { headers } from "next/headers";
import { webDal } from "../dal/instance";
import type { AuthEmailKind } from "../dal/auth-rate";
import { clientIpHash } from "./client-ip";

/** True when this request may send an email. A failing counter counts as "no": never send unmetered. */
export async function withinLimit(kind: AuthEmailKind): Promise<boolean> {
  try {
    const { allowed } = await webDal().authRate.hit(clientIpHash(await headers()), kind);
    return allowed;
  } catch (error) {
    logFailure("auth_rate_failed", kind, error);
    return false;
  }
}

/** One fixed-shape line: event, kind and error class only (never the address, the IP or a code). */
export function logFailure(event: string, kind: AuthEmailKind, error: unknown) {
  const status = Number((error as { status?: unknown } | null)?.status) || null;
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, kind, errorClass: (error as { name?: unknown } | null)?.name && typeof (error as { name: unknown }).name === "string" ? (error as { name: string }).name : "unknown", status }));
}
