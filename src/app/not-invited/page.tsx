import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ContactText } from "@/components/app/contact-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { signOut } from "@/app/login/actions";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { mayCreateAccount } from "@/lib/server/auth/signup-policy";
import { signupPolicy } from "@/lib/server/env";

export const metadata: Metadata = { title: "Private test" };

export default async function NotInvitedPage() {
  const user = await getRequestUser();
  if (!user) redirect("/login");
  // Only an address with no profile that is not invited belongs here; anyone else goes to the workspace (which creates or loads the account).
  if (mayCreateAccount(signupPolicy(), user.email) || (await webDal().account.getStatus(user.ctx)) !== null) redirect("/dashboard");
  return (
    <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
      <Card className="p-6 md:p-8">
        <h1 className="select-none font-heading text-2xl font-semibold text-foreground">This is a private test</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="select-text">{user.email}</span> is not on the invite list, so no NotePrep workspace or free generations were set up for it.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          <ContactText text="Signing in created a sign-in record (your email address and password) that we keep until it is removed on request. To have it removed, or if you were invited with a different address, contact us. You can also sign out and use the invited address." />
        </p>
        <form className="mt-6">
          <Button type="submit" variant="outline" formAction={signOut}>
            Sign out
          </Button>
        </form>
      </Card>
    </main>
  );
}
