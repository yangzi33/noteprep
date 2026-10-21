import { PublicHeader } from "@/components/app/public-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { TextField } from "@/components/ui/text-field";
import { signIn, signUp } from "./actions";

const MESSAGES: Record<string, string> = {
  invalid: "Check your email and password (at least 10 characters) and try again.",
  unverified: "Please confirm your email address first.",
  callback: "That confirmation link is invalid or expired.",
  "check-email": "If the address can be used, a confirmation email is on its way.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = await searchParams;
  const message = MESSAGES[error ?? notice ?? ""];
  return (
    <>
      <PublicHeader />
      <main className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
        <Card className="p-6 md:p-8">
          <h1 className="font-heading text-2xl font-semibold text-foreground">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in or create an account with your email address.</p>
          {message && (
            <Notice intent={error ? "error" : "info"} role="status" className="mt-4">
              {message}
            </Notice>
          )}
          <form className="mt-6 flex flex-col gap-4">
            <TextField label="Email" name="email" type="email" required autoComplete="email" />
            <TextField
              label="Password"
              name="password"
              type="password"
              required
              minLength={10}
              maxLength={72}
              autoComplete="current-password"
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" formAction={signIn}>
                Sign in
              </Button>
              <Button type="submit" variant="outline" formAction={signUp}>
                Create account
              </Button>
            </div>
          </form>
        </Card>
      </main>
    </>
  );
}
