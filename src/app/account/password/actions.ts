"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAccount } from "@/lib/server/auth/require-user";
import { createServerSupabase } from "@/lib/supabase/server";

const NewPassword = z.object({ password: z.string().min(10).max(72), confirm: z.string().max(72) });

export async function updatePassword(formData: FormData) {
  await requireAccount(); // identity is verified on the server again; a signed-out caller is sent to sign in
  const parsed = NewPassword.safeParse({ password: formData.get("password"), confirm: formData.get("confirm") });
  if (!parsed.success) redirect("/account/password?error=invalid");
  if (parsed.data.password !== parsed.data.confirm) redirect("/account/password?error=mismatch");
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) redirect("/account/password?error=failed");
  await supabase.auth.signOut({ scope: "others" }).catch(() => undefined); // end every other session; this one stays
  redirect("/account?notice=password-updated");
}
