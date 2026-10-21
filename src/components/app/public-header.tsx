import Link from "next/link";
import { Logo } from "@/components/app/logo";

export function PublicHeader() {
  return (
    <header className="flex min-h-[72px] items-center border-b bg-card px-4 md:min-h-20 md:px-8">
      <Link href="/" className="rounded-control focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none">
        <Logo />
      </Link>
      <Link
        href="/login"
        className="ml-auto inline-flex min-h-11 items-center rounded-control px-2 text-sm font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
      >
        Sign in
      </Link>
    </header>
  );
}
