import { Button } from "@/components/ui/button";
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
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {message && (
        <p role="status" className="mt-4 text-sm">
          {message}
        </p>
      )}
      <form className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoComplete="email" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={10}
            maxLength={72}
            autoComplete="current-password"
            className="rounded border px-3 py-2"
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" formAction={signIn} formMethod="post">
            Sign in
          </Button>
          <Button type="submit" variant="outline" formAction={signUp} formMethod="post">
            Create account
          </Button>
        </div>
      </form>
    </main>
  );
}
