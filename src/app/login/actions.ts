"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { withinLimit } from "@/lib/server/auth/email-limit";
import { mayCreateAccount } from "@/lib/server/auth/signup-policy";
import { signupPolicy } from "@/lib/server/env";
import { publicEnv } from "@/lib/supabase/public-env";

const Credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(10).max(72),
});

function parse(formData: FormData) {
  return Credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
}

export async function signIn(formData: FormData) {
  const parsed = parse(formData);
  if (!parsed.success) redirect("/login?error=invalid");
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  // One message for every failure (wrong password, unknown or unconfirmed address).
  if (error) redirect("/login?error=invalid");
  redirect("/dashboard");
}

export async function signUp(formData: FormData) {
  const parsed = parse(formData);
  if (!parsed.success) redirect("/login?error=invalid");
  const policy = signupPolicy();
  // The counter is hit for every address, listed or not, so both branches do the same metered work before the (listed-only) Auth call.
  const withinRate = await withinLimit("signup");
  if (withinRate && mayCreateAccount(policy, parsed.data.email)) {
    const supabase = await createServerSupabase();
    await supabase.auth.signUp({
      ...parsed.data,
      options: { emailRedirectTo: `${publicEnv().siteUrl}/auth/callback` },
    });
  }
  // The reply is the same whether or not the address exists, is invited or was rate limited. Response time still differs for a listed address (it also pays the remote Auth round trip), so this does not fully hide invite-list membership; see docs/auth-recovery.md.
  redirect(policy.mode === "invite" ? "/login?notice=check-email-invite" : "/login?notice=check-email");
}

export async function signOut() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/");
}
