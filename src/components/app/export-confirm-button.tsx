"use client";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

const PENDING_LABEL = "Starting your export…";

/** Disabled while the form is submitting (cosmetic: the server's idempotency key is what prevents a double charge). */
export function ExportConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" disabled={pending} aria-busy={pending ? "true" : undefined} data-testid="export-confirm">
        {pending ? (
          <>
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            <span aria-hidden="true">{PENDING_LABEL}</span>
          </>
        ) : (
          "Export PDFs"
        )}
      </Button>
      <p className="sr-only" role="status" aria-live="polite" data-testid="export-pending">
        {pending ? PENDING_LABEL : ""}
      </p>
    </>
  );
}
