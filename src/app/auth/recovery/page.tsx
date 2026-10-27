import type { Metadata } from "next";
import Link from "next/link";
import { SignedOutHeader } from "@/components/app/signed-out-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { parseRecoveryParams } from "@/lib/auth/recovery-params";
import { loginMessage } from "@/lib/ui/login-messages";
import { confirmRecovery } from "./actions";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false },
  referrer: "no-referrer",
};

const first = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parsed = parseRecoveryParams({ token_hash: first(sp.token_hash), type: first(sp.type), code: first(sp.code) });
  return (
    <>
      <SignedOutHeader />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
        <Card className="p-6 md:p-8">
          {parsed ? (
            <>
              <h1 className="font-heading text-2xl font-semibold text-foreground">Reset your password</h1>
              <p className="mt-1 text-sm text-muted-foreground">Press Continue to choose a new password.</p>
              <form action={confirmRecovery} className="mt-6">
                <input type="hidden" name={parsed.kind} value={parsed.value} />
                <Button type="submit">Continue</Button>
              </form>
            </>
          ) : (
            <>
              <h1 className="font-heading text-2xl font-semibold text-foreground">This link cannot be used</h1>
              <Notice intent="error" className="mt-4">
                {loginMessage("recovery")}
              </Notice>
              <Link
                href="/login/reset"
                className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Request a new link
              </Link>
            </>
          )}
        </Card>
      </main>
    </>
  );
}
