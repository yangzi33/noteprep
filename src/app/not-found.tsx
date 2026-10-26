import type { Metadata } from "next";
import Link from "next/link";
import { SignedOutHeader } from "@/components/app/signed-out-header";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <SignedOutHeader />
      <main className="mx-auto max-w-xl px-4 py-16 md:px-8">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The page you asked for does not exist or is no longer available.</p>
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline">
          Back to the home page
        </Link>
      </main>
    </>
  );
}
