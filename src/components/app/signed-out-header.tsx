import { PublicHeader } from "@/components/app/public-header";
import { getRequestUser } from "@/lib/server/auth/require-user";

/** The public header, only for visitors without a session (signed-in pages get AppHeader from the layout). */
export async function SignedOutHeader() {
  const user = await getRequestUser();
  return user ? null : <PublicHeader />;
}
