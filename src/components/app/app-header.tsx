import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";

export function AppHeader({ email }: { email: string }) {
  const initial = email.trim().charAt(0).toUpperCase() || "?";
  return (
    <header className="flex min-h-[72px] items-center gap-4 border-b bg-card px-4 md:min-h-20 md:px-8">
      <div className="flex items-baseline gap-4">
        <Link href="/" className="rounded-control focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none">
          <Logo />
        </Link>
        <p className="hidden text-sm text-muted-foreground md:block">Your tutor workspace</p>
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-text-accent"
        >
          {initial}
        </span>
        <Link
          href="/account"
          className="inline-flex min-h-11 min-w-0 max-w-[240px] items-center rounded-control text-sm hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none max-sm:hidden"
        >
          <span className="truncate">{email}</span>
        </Link>
        <form>
          <Button type="submit" variant="outline" size="sm" formAction={signOut}>
            Sign out
          </Button>
        </form>
      </div>
    </header>
  );
}
