"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Disabled while the form is submitting (cosmetic: the server's idempotency key is what prevents a double charge). */
export function ExportConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} aria-busy={pending ? "true" : undefined} data-testid="export-confirm">
      Export PDFs
    </Button>
  );
}
