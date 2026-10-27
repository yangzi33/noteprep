import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { publicEnv } from "./public-env";

/** A new client per request: it is bound to this request's cookies. */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  const env = publicEnv();
  return createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session on every request.
        }
      },
    },
  });
}

/**
 * A client that neither reads nor keeps any cookie. For unauthenticated actions whose response must not depend on the
 * outcome: any session or PKCE verifier the call would set is discarded, so no path differs by Set-Cookie.
 */
export function createStatelessSupabase() {
  const env = publicEnv();
  return createServerClient(env.url, env.publishableKey, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
