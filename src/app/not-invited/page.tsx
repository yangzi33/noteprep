import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ContactText } from "@/components/app/contact-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { signOut } from "@/app/login/actions";
import { getRequestUser } from "@/lib/server/auth/require-user";

export const metadata: Metadata = { title: "Private test" };

export default async function NotInvitedPage() {
  const user = await getRequestUser();
  if (!user) redirect("/login");
  return (
    <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
      <Card className="p-6 md:p-8">
        <h1 className="select-none font-heading text-2xl font-semibold text-foreground">This is a private test</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="select-text">{user.email}</span> is not on the invite list, so no account was created for it.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          <ContactText text="If you were invited with a different address, sign out and use that one, or contact us." />
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
