import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { TextField } from "@/components/ui/text-field";
import { requireAccount } from "@/lib/server/auth/require-user";
import { passwordMessage } from "@/lib/ui/login-messages";
import { updatePassword } from "./actions";

export const metadata: Metadata = { title: "Set a new password" };

export default async function PasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAccount();
  const { error } = await searchParams;
  const message = passwordMessage(error);
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-4 py-8 md:px-8">
      <h1 className="font-heading text-2xl font-semibold text-foreground">Set a new password</h1>
      <Card className="mt-6 p-6">
        {message && (
          <Notice intent="error" className="mb-4">
            {message}
          </Notice>
        )}
        <form action={updatePassword} className="flex flex-col gap-4">
          <TextField label="New password" name="password" type="password" required minLength={10} maxLength={72} autoComplete="new-password" hint="At least 10 characters" />
          <TextField label="Confirm new password" name="confirm" type="password" required minLength={10} maxLength={72} autoComplete="new-password" />
          <div>
            <Button type="submit">Set new password</Button>
          </div>
        </form>
      </Card>
      <Link href="/account" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        Back to your account
      </Link>
    </main>
  );
}
