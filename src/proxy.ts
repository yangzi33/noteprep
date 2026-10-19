import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/session";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Skip static assets and the liveness probe; everything else may carry a session.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
