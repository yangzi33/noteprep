import type { Metadata } from "next";
import { LoginForm } from "@/components/app/login-form";
import { SignedOutHeader } from "@/components/app/signed-out-header";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { loginMessage } from "@/lib/ui/login-messages";
import { signIn, signUp } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams;
  const message = loginMessage(error ?? notice);
  return (
    <>
      <SignedOutHeader />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
        <Card className="p-6 md:p-8">
          <h1 className="font-heading text-2xl font-semibold text-foreground">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            New here? Enter an email and a password, then choose Create account. Already registered? Choose Sign in.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Please do not enter student names anywhere in NotePrep.</p>
          {message && (
            <Notice intent={error ? "error" : "info"} {...(error ? {} : { role: "status" as const })} className="mt-4">
              {message}
            </Notice>
          )}
          <LoginForm signIn={signIn} signUp={signUp} />
        </Card>
      </main>
    </>
  );
}
