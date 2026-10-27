import Link from "next/link";
import { SignedOutHeader } from "@/components/app/signed-out-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { TextField } from "@/components/ui/text-field";

/** Shared page of the two email-only recovery forms. The error text is chosen here, never taken from the query string. */
export function EmailRequestPage({
  title,
  intro,
  submitLabel,
  action,
  invalid,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  action: (formData: FormData) => void | Promise<void>;
  invalid: boolean;
}) {
  return (
    <>
      <SignedOutHeader />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 md:py-16">
        <Card className="p-6 md:p-8">
          <h1 className="select-none font-heading text-2xl font-semibold text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
          {invalid && (
            <Notice intent="error" className="mt-4">
              Enter a valid email address and try again.
            </Notice>
          )}
          <form action={action} className="mt-6 flex flex-col gap-4">
            <TextField label="Email" name="email" type="email" required maxLength={254} autoComplete="email" />
            <div>
              <Button type="submit">{submitLabel}</Button>
            </div>
          </form>
          <Link href="/login" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Back to Sign in
          </Link>
        </Card>
      </main>
    </>
  );
}
