"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
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
  const supabase = await createServerSupabase();
  await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${publicEnv().siteUrl}/auth/callback` },
  });
  // Same response whether or not the address already exists, so this cannot be used to probe accounts.
  redirect("/login?notice=check-email");
}

export async function signOut() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/");
}
