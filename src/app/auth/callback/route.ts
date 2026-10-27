import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/server/auth/redirects";
import { publicEnv } from "@/lib/supabase/public-env";
import { createServerSupabase } from "@/lib/supabase/server";

const OTP_TYPES = ["signup", "email"] as const;

// Email confirmation lands here with a token hash (any browser) or a one-time PKCE code.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = publicEnv().siteUrl; // never the request Host header
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = OTP_TYPES.find((t) => t === searchParams.get("type"));
  let ok = false;
  try {
    if (tokenHash && type) {
      const supabase = await createServerSupabase();
      ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
    } else if (code) {
      const supabase = await createServerSupabase();
      ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
    }
  } catch {
    ok = false; // fail closed, same redirect as any other failure
  }
  if (ok) return NextResponse.redirect(new URL(safeNextPath(searchParams.get("next")), origin));
  return NextResponse.redirect(new URL("/login?error=callback", origin));
}
