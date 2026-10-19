import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { getRequestUser } from "@/lib/server/auth/require-user";

export async function SiteNav() {
  const user = await getRequestUser();
  return (
    <header className="border-b">
      <nav aria-label="Main" className="mx-auto flex max-w-3xl items-center gap-4 px-8 py-3 text-sm">
        <Link href="/" className="font-semibold">
          noteprep
        </Link>
        {user ? (
          <>
            <Link href="/prepare">Prepare</Link>
            <Link href="/lessons/new">Quick form</Link>
            <Link href="/lessons">History</Link>
            <span className="ml-auto text-muted-foreground">{user.email}</span>
            <form>
              <Button type="submit" variant="outline" size="sm" formAction={signOut} formMethod="post">
                Sign out
              </Button>
            </form>
          </>
        ) : (
          <Link href="/login" className="ml-auto">
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
