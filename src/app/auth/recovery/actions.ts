"use server";

import { redirect } from "next/navigation";
import { parseRecoveryParams } from "@/lib/auth/recovery-params";
import { createServerSupabase } from "@/lib/supabase/server";

const field = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === "string" ? v : undefined;
};

/** Redeems the reset token on POST only, so a mail scanner's GET cannot consume it. Fixed destinations, nothing logged or echoed. */
export async function confirmRecovery(formData: FormData) {
  const parsed = parseRecoveryParams({
    token_hash: field(formData, "token_hash"),
    type: "recovery",
    code: field(formData, "code"),
  });
  if (!parsed) redirect("/login?error=recovery");
  let ok = false;
  try {
    const supabase = await createServerSupabase();
    const { error } =
      parsed.kind === "token_hash"
        ? await supabase.auth.verifyOtp({ type: "recovery", token_hash: parsed.value })
        : await supabase.auth.exchangeCodeForSession(parsed.value);
    ok = !error;
  } catch {
    ok = false;
  }
  if (!ok) redirect("/login?error=recovery");
  redirect("/account/password");
}
