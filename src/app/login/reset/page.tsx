import type { Metadata } from "next";
import { EmailRequestPage } from "@/components/app/email-request-form";
import { requestPasswordReset } from "../recovery-actions";

export const metadata: Metadata = { title: "Reset your password" };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <EmailRequestPage
      title="Reset your password"
      intro="Enter the email address of your account and we will send you a link to choose a new password."
      submitLabel="Send reset link"
      action={requestPasswordReset}
      invalid={error === "invalid"}
    />
  );
}
