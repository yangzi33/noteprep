"use client";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { usePreparePending } from "@/components/app/prepare-pending";

export function GenerateButtonView({
  exhausted,
  pending,
  submitting = false,
  label = "Generate lesson",
  pendingLabel = "Creating your draft…",
}: {
  exhausted: boolean;
  pending: boolean;
  submitting?: boolean;
  label?: string;
  pendingLabel?: string;
}) {
  return (
    <>
      <Button type="submit" disabled={exhausted || pending || submitting} aria-busy={pending || submitting ? "true" : undefined} className="w-full">
        {submitting ? (
          <>
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            <span aria-hidden="true">{pendingLabel}</span>
          </>
        ) : (
          label
        )}
      </Button>
      <p className="sr-only" role="status" aria-live="polite" data-testid="generate-pending">
        {submitting ? pendingLabel : ""}
      </p>
    </>
  );
}

/** Disabled while a dropdown change is navigating (so the form's stale hidden topic cannot be submitted) and while the form is submitting. */
export function GenerateButton({ exhausted, label, pendingLabel }: { exhausted: boolean; label?: string; pendingLabel?: string }) {
  const { pending } = usePreparePending();
  const { pending: submitting } = useFormStatus();
  return <GenerateButtonView exhausted={exhausted} pending={pending} submitting={submitting} label={label} pendingLabel={pendingLabel} />;
}
