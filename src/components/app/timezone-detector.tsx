"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DETECTED_TZ_COOKIE } from "@/lib/ui/timezone";

/** Reports the browser's zone to the server in a cookie so server-rendered times can use it. Renders nothing. */
export function TimezoneDetector() {
  const router = useRouter();
  useEffect(() => {
    let detected: string | undefined;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!detected) return;
    const current = document.cookie.split("; ").find((c) => c.startsWith(`${DETECTED_TZ_COOKIE}=`))?.slice(DETECTED_TZ_COOKIE.length + 1);
    if (current === encodeURIComponent(detected)) return;
    document.cookie = `${DETECTED_TZ_COOKIE}=${encodeURIComponent(detected)}; path=/; max-age=31536000; SameSite=Lax`;
    // Refresh only if the cookie stuck; with cookies blocked this would otherwise loop.
    if (document.cookie.includes(`${DETECTED_TZ_COOKIE}=${encodeURIComponent(detected)}`)) router.refresh();
  }, [router]);
  return null;
}
