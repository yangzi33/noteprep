import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requireAccount } from "@/lib/server/auth/require-user";
import { signOut } from "../login/actions";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const { email } = await requireAccount();
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 md:px-8">
      <h1 className="font-heading text-2xl font-semibold text-foreground">Account</h1>
      <Card className="mt-6 p-6">
        <p className="text-sm text-foreground">Signed in as {email}.</p>
        <form className="mt-4">
          <Button type="submit" variant="outline" formAction={signOut}>
            Sign out
          </Button>
        </form>
      </Card>
    </main>
  );
}
