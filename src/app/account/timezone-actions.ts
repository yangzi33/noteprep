"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { matchTimeZone } from "@/lib/ui/timezone";

export async function saveTimeZone(formData: FormData) {
  const { ctx } = await requireAccount();
  const raw = formData.get("timezone");
  const zone = typeof raw === "string" && raw.length <= 100 ? matchTimeZone(raw) : null;
  if (!zone) redirect("/account?error=timezone-invalid");
  await webDal().account.setTimeZone(ctx, zone);
  revalidatePath("/", "layout");
  redirect("/account?notice=timezone-saved");
}

export async function resetTimeZone() {
  const { ctx } = await requireAccount();
  await webDal().account.setTimeZone(ctx, null);
  revalidatePath("/", "layout");
  redirect("/account?notice=timezone-reset");
}
