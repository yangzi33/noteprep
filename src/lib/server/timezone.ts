import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import type { AuthedCtx } from "@/lib/server/auth/context";
import { webDal } from "@/lib/server/dal/instance";
import { DETECTED_TZ_COOKIE, isValidTimeZone, resolveTimeZone } from "@/lib/ui/timezone";

export interface TimeZoneInfo {
  /** The saved preference when it is usable, else null (Auto). */
  saved: string | null;
  /** The zone times are shown in. */
  effective: string;
}

/**
 * The zone times are displayed in for this request: the caller's saved preference, else the zone their browser
 * reported in a cookie, else UTC. The cookie is untrusted input and is only ever used as a display zone after
 * validation. Display only; nothing stored depends on it.
 */
export const getTimeZoneInfo = cache(async (ctx: AuthedCtx): Promise<TimeZoneInfo> => {
  const [saved, jar] = await Promise.all([webDal().account.getTimeZone(ctx), cookies()]);
  const raw = jar.get(DETECTED_TZ_COOKIE)?.value;
  let detected: string | undefined;
  try {
    detected = raw === undefined ? undefined : decodeURIComponent(raw);
  } catch {
    detected = undefined;
  }
  return { saved: isValidTimeZone(saved) ? saved : null, effective: resolveTimeZone(saved, detected) };
});

export async function getDisplayTimeZone(ctx: AuthedCtx): Promise<string> {
  return (await getTimeZoneInfo(ctx)).effective;
}
