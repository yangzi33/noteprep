import "server-only";
import { redirect } from "next/navigation";
import { AccountNotActive } from "@/lib/domain/errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { webDal } from "../dal/instance";
import { makeAuthedCtx, type AuthedCtx } from "./context";
import { isEmailConfirmed, verifyClaims } from "./verify";

/**
 * The only producer of AuthedCtx for requests. Identity comes from a JWT verified on the server;
 * the browser's cookies are never trusted as a user id. Unauthenticated callers are redirected.
 */
export async function requireUser(): Promise<{ ctx: AuthedCtx; email: string }> {
  const supabase = await createServerSupabase();
  const user = await verifyClaims(supabase);
  if (!user) redirect("/login");
  return { ctx: makeAuthedCtx(user.userId), email: user.email };
}

/**
 * requireUser plus the application account: creates the profile and its single trial bucket on first
 * use, but only after the Auth server confirms the email address.
 */
export async function requireAccount(): Promise<{ ctx: AuthedCtx; email: string }> {
  const { ctx, email } = await requireUser();
  const dal = webDal();
  const status = await dal.account.getStatus(ctx);
  if (status === "active") return { ctx, email };
  if (status === "deleting") throw new AccountNotActive();

  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  if (!isEmailConfirmed(data.user, ctx.userId)) redirect("/login?error=unverified");
  await dal.account.ensureAccount(ctx);
  return { ctx, email };
}
