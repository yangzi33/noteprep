"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { logFailure, withinLimit } from "@/lib/server/auth/email-limit";
import { mayCreateAccount } from "@/lib/server/auth/signup-policy";
import { signupPolicy } from "@/lib/server/env";
import { publicEnv } from "@/lib/supabase/public-env";
import { createStatelessSupabase } from "@/lib/supabase/server";

const EmailOnly = z.object({ email: z.email().max(254) });

export async function requestPasswordReset(formData: FormData) {
  const parsed = EmailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/login/reset?error=invalid");
  if (await withinLimit("reset")) {
    try {
      const supabase = createStatelessSupabase();
      const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${publicEnv().siteUrl}/auth/recovery` });
      if (error) logFailure("auth_email_failed", "reset", error);
    } catch (error) {
      logFailure("auth_email_failed", "reset", error); // the response must not depend on the address or on the provider
    }
  }
  // Same response whether or not the address has an account, the limit was reached or the call failed.
  redirect("/login?notice=reset-sent");
}

export async function resendConfirmation(formData: FormData) {
  const parsed = EmailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/login/resend?error=invalid");
  const policy = signupPolicy();
  // The counter is hit for every address, listed or not, so both branches do the same metered work before the (listed-only) provider call.
  const withinRate = await withinLimit("resend");
  if (withinRate && mayCreateAccount(policy, parsed.data.email)) {
    try {
      const supabase = createStatelessSupabase();
      const { error } = await supabase.auth.resend({ type: "signup", email: parsed.data.email, options: { emailRedirectTo: `${publicEnv().siteUrl}/auth/callback` } });
      if (error) logFailure("auth_email_failed", "resend", error);
    } catch (error) {
      logFailure("auth_email_failed", "resend", error);
    }
  }
  redirect(policy.mode === "invite" ? "/login?notice=check-email-invite" : "/login?notice=check-email");
}
