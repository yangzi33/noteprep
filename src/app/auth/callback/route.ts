import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/server/auth/redirects";
import { publicEnv } from "@/lib/supabase/public-env";
import { createServerSupabase } from "@/lib/supabase/server";

// Email confirmation lands here with a one-time PKCE code.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = publicEnv().siteUrl; // never the request Host header
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(safeNextPath(searchParams.get("next")), origin));
  }
  return NextResponse.redirect(new URL("/login?error=callback", origin));
}
