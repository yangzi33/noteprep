import type { Metadata } from "next";
import { EmailRequestPage } from "@/components/app/email-request-form";
import { resendConfirmation } from "../recovery-actions";

export const metadata: Metadata = { title: "Resend the confirmation email" };

export default async function ResendPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <EmailRequestPage
      title="Resend the confirmation email"
      intro="Enter the email address you signed up with and we will send the confirmation link again."
      submitLabel="Resend email"
      action={resendConfirmation}
      invalid={error === "invalid"}
    />
  );
}
