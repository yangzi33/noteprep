import Link from "next/link";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";
import { landingContent } from "@/lib/marketing/content";

const focus = "focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

/**
 * The header for signed-out visitors. "simple" (login, not-found) has one Sign in link; "landing" matches the landing
 * design: anchor links to sections of the page (hidden below md), a Sign in link and a Get started button.
 */
export function PublicHeader({ variant = "simple" }: { variant?: "simple" | "landing" }) {
  if (variant === "landing") {
    return (
      <header className="border-b bg-background">
        <div className="mx-auto flex min-h-[72px] w-full max-w-[1440px] items-center gap-4 px-4 md:min-h-24 md:px-10 lg:px-20">
          <Link href="/" className={`rounded-control ${focus}`}>
            <Logo />
          </Link>
          <nav aria-label="Page sections" className="mx-auto hidden items-center gap-2 md:flex">
            {landingContent.nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`inline-flex min-h-11 items-center rounded-control px-4 text-sm text-foreground hover:text-text-accent ${focus}`}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1 md:ml-0 md:gap-3">
            <Link href="/login" className={`inline-flex min-h-11 items-center rounded-control px-3 text-sm text-foreground hover:text-text-accent ${focus}`}>
              Sign in
            </Link>
            <Button asChild>
              <Link href="/login">Get started</Link>
            </Button>
          </div>
        </div>
      </header>
    );
  }
  return (
    <header className="flex min-h-[72px] items-center border-b bg-card px-4 md:min-h-20 md:px-8">
      <Link href="/" className={`rounded-control ${focus}`}>
        <Logo />
      </Link>
      <Link
        href="/login"
        className={`ml-auto inline-flex min-h-11 items-center rounded-control px-2 text-sm font-medium text-text-accent underline-offset-4 hover:underline ${focus}`}
      >
        Sign in
      </Link>
    </header>
  );
}
