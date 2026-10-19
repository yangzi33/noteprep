import "server-only";
import { redirect } from "next/navigation";
import { AccountNotActive } from "@/lib/domain/errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { webDal } from "../dal/instance";
import { makeAuthedCtx, type AuthedCtx } from "./context";
import { isEmailConfirmed, verifyClaims } from "./verify";

/**
 * Identity for the current request without redirecting: null when signed out. Identity comes from a JWT
 * verified on the server; the browser's cookies are never trusted as a user id.
 */
export async function getRequestUser(): Promise<{ ctx: AuthedCtx; email: string } | null> {
  const supabase = await createServerSupabase();
  const user = await verifyClaims(supabase);
  return user ? { ctx: makeAuthedCtx(user.userId), email: user.email } : null;
}

/** The producer of AuthedCtx for pages and actions: unauthenticated callers are redirected to sign in. */
export async function requireUser(): Promise<{ ctx: AuthedCtx; email: string }> {
  const user = await getRequestUser();
  if (!user) redirect("/login");
  return user;
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
