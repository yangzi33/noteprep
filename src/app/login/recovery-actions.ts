"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIpHash } from "@/lib/server/auth/client-ip";
import { webDal } from "@/lib/server/dal/instance";
import { publicEnv } from "@/lib/supabase/public-env";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AuthEmailKind } from "@/lib/server/dal/auth-rate";

const EmailOnly = z.object({ email: z.email().max(254) });

/** True when this request may send an email. A failing counter counts as "no": never send unmetered. */
async function withinLimit(kind: AuthEmailKind): Promise<boolean> {
  try {
    const { allowed } = await webDal().authRate.hit(clientIpHash(await headers()), kind);
    return allowed;
  } catch {
    return false;
  }
}

export async function requestPasswordReset(formData: FormData) {
  const parsed = EmailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/login/reset?error=invalid");
  if (await withinLimit("reset")) {
    try {
      const supabase = await createServerSupabase();
      await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${publicEnv().siteUrl}/auth/recovery` });
    } catch {
      // Ignored on purpose: the response must not depend on the address or on the provider.
    }
  }
  // Same response whether or not the address has an account, the limit was reached or the call failed.
  redirect("/login?notice=reset-sent");
}

export async function resendConfirmation(formData: FormData) {
  const parsed = EmailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/login/resend?error=invalid");
  if (await withinLimit("resend")) {
    try {
      const supabase = await createServerSupabase();
      await supabase.auth.resend({ type: "signup", email: parsed.data.email, options: { emailRedirectTo: `${publicEnv().siteUrl}/auth/callback` } });
    } catch {
      // Ignored on purpose, as above.
    }
  }
  redirect("/login?notice=check-email");
}
