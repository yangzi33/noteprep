"use client";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { usePreparePending } from "@/components/app/prepare-pending";

export function GenerateButtonView({ exhausted, pending, submitting = false, label = "Generate lesson" }: { exhausted: boolean; pending: boolean; submitting?: boolean; label?: string }) {
  return (
    <Button type="submit" disabled={exhausted || pending || submitting} aria-busy={pending || submitting ? "true" : undefined} className="w-full">
      {submitting ? (
        <>
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          <span role="status" aria-live="polite">
            Creating your draft…
          </span>
        </>
      ) : (
        label
      )}
    </Button>
  );
}

/** Disabled while a dropdown change is navigating (so the form's stale hidden topic cannot be submitted) and while the form is submitting. */
export function GenerateButton({ exhausted, label }: { exhausted: boolean; label?: string }) {
  const { pending } = usePreparePending();
  const { pending: submitting } = useFormStatus();
  return <GenerateButtonView exhausted={exhausted} pending={pending} submitting={submitting} label={label} />;
}
