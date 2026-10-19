import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export interface VerifiedUser {
  userId: string;
  email: string;
}

const uuid = z.uuid();

/**
 * Only tokens signed with an asymmetric key are accepted. For HS256 the Auth server verifies with the
 * shared legacy secret, so anyone who holds that secret could mint a token for any user id (observed
 * against the local stack, tests/supabase/auth.test.ts). Hosted projects must also use asymmetric
 * signing keys and retire the legacy secret (docs/security-and-privacy.md section 9).
 */
const ALLOWED_ALGORITHMS = new Set(["ES256", "RS256", "EdDSA"]);

/**
 * Verifies a JWT's signature and expiry (getClaims; with asymmetric signing keys this checks against
 * the published JWKS) and accepts only real, non-anonymous end users. Without `jwt` the session is
 * read from the client's cookies. Returns null for anything else: forged, expired, service-role,
 * anonymous or malformed tokens.
 */
export async function verifyClaims(supabase: SupabaseClient, jwt?: string): Promise<VerifiedUser | null> {
  const { data, error } = await supabase.auth.getClaims(jwt);
  if (error || !data) return null;
  if (!ALLOWED_ALGORITHMS.has(data.header.alg)) return null;
  const claims = data.claims;
  if (claims.role !== "authenticated" || claims.is_anonymous === true) return null;
  if (!claims.email || !uuid.safeParse(claims.sub).success) return null;
  return { userId: claims.sub, email: claims.email };
}

/** Only an address confirmed with the Auth server may receive a free allowance. */
export function isEmailConfirmed(user: { id: string; email_confirmed_at?: string | null } | null, expectedUserId: string) {
  return !!user && user.id === expectedUserId && !!user.email_confirmed_at;
}
