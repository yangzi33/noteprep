import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/supabase/public-env";
import { createServerSupabase } from "@/lib/supabase/server";

// The password-reset email lands here with a one-time PKCE code. The destination is fixed: any `next` parameter is ignored.
export async function GET(request: NextRequest) {
  const origin = publicEnv().siteUrl; // never the request Host header
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/account/password", origin));
  }
  return NextResponse.redirect(new URL("/login?error=recovery", origin));
}
