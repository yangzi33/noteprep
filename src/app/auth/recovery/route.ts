import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/supabase/public-env";
import { createServerSupabase } from "@/lib/supabase/server";

// The password-reset email lands here with a token hash (any browser) or, for old links, a one-time PKCE code.
// The destination is fixed: any `next` parameter is ignored and no parameter is echoed.
export async function GET(request: NextRequest) {
  const origin = publicEnv().siteUrl; // never the request Host header
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const code = params.get("code");
  try {
    if (tokenHash) {
      if (params.get("type") === "recovery") {
        const supabase = await createServerSupabase();
        const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
        if (!error) return NextResponse.redirect(new URL("/account/password", origin));
      }
    } else if (code) {
      const supabase = await createServerSupabase();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL("/account/password", origin));
    }
  } catch {
    // Falls through to the same failure redirect.
  }
  return NextResponse.redirect(new URL("/login?error=recovery", origin));
}
