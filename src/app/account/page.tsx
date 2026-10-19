import { Button } from "@/components/ui/button";
import { requireAccount } from "@/lib/server/auth/require-user";
import { signOut } from "../login/actions";

export default async function AccountPage() {
  const { email } = await requireAccount();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Account</h1>
      <p className="mt-2">Signed in as {email}.</p>
      <form className="mt-6">
        <Button type="submit" variant="outline" formAction={signOut}>
          Sign out
        </Button>
      </form>
    </main>
  );
}
