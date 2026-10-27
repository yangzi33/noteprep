"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIpHash } from "@/lib/server/auth/client-ip";
import { webDal } from "@/lib/server/dal/instance";
import { publicEnv } from "@/lib/supabase/public-env";
import { createStatelessSupabase } from "@/lib/supabase/server";
import type { AuthEmailKind } from "@/lib/server/dal/auth-rate";

const EmailOnly = z.object({ email: z.email().max(254) });

/** True when this request may send an email. A failing counter counts as "no": never send unmetered. */
async function withinLimit(kind: AuthEmailKind): Promise<boolean> {
  try {
    const { allowed } = await webDal().authRate.hit(clientIpHash(await headers()), kind);
    return allowed;
  } catch (error) {
    logFailure("auth_rate_failed", kind, error);
    return false;
  }
}

/** One fixed-shape line: event, kind and error class only (never the address, the IP or a code). */
function logFailure(event: string, kind: AuthEmailKind, error: unknown) {
  const status = Number((error as { status?: unknown } | null)?.status) || null;
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, kind, errorClass: error instanceof Error ? error.name : "unknown", status }));
}

export async function requestPasswordReset(formData: FormData) {
  const parsed = EmailOnly.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/login/reset?error=invalid");
  if (await withinLimit("reset")) {
    try {
      const supabase = createStatelessSupabase();
      await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${publicEnv().siteUrl}/auth/recovery` });
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
  if (await withinLimit("resend")) {
    try {
      const supabase = createStatelessSupabase();
      await supabase.auth.resend({ type: "signup", email: parsed.data.email, options: { emailRedirectTo: `${publicEnv().siteUrl}/auth/callback` } });
    } catch (error) {
      logFailure("auth_email_failed", "resend", error);
    }
  }
  redirect("/login?notice=check-email");
}
