"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { errorReference } from "@/lib/ui/error-reference";

/** Route-level error boundary. It never renders error.message; the digest is an opaque id that matches the server log line. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reference = errorReference(error.digest);
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-xl px-4 py-16 md:px-8">
      <div role="alert">
        <h1 className="select-none font-heading text-2xl font-semibold text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">Something went wrong on our side. Your drafts are saved.</p>
        {reference && <p className="mt-2 text-sm text-muted-foreground">{reference}</p>}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline">
          Go to dashboard
        </Link>
      </div>
    </main>
  );
}
