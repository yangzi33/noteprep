"use client";

import "./globals.css";
import { errorReference } from "@/lib/ui/error-reference";

/** Last-resort boundary for a failure in the root layout itself. It replaces the layout, so it brings its own html and body, and it never renders error.message. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reference = errorReference(error.digest);
  return (
    <html lang="en">
      <body className="min-h-screen bg-background">
        <main id="main" className="mx-auto max-w-xl px-4 py-16 md:px-8">
          <div role="alert">
            <h1 className="font-heading text-2xl font-semibold text-foreground">Something went wrong</h1>
            <p className="mt-2 text-sm text-muted-foreground">Something went wrong on our side. Your drafts are saved.</p>
            {reference && <p className="mt-2 text-sm text-muted-foreground">{reference}</p>}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex min-h-11 items-center rounded-control bg-foreground px-4 text-sm font-medium text-background focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
            >
              Try again
            </button>
            <a href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline">
              Go to dashboard
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
