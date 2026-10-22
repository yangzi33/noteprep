"use client";

import { Button } from "@/components/ui/button";
import { usePreparePending } from "@/components/app/prepare-pending";

export function GenerateButtonView({ exhausted, pending, label = "Generate lesson" }: { exhausted: boolean; pending: boolean; label?: string }) {
  return (
    <Button type="submit" disabled={exhausted || pending} aria-busy={pending ? "true" : undefined} className="w-full">
      {label}
    </Button>
  );
}

/** Disabled while a dropdown change is navigating, so the form's stale hidden topic cannot be submitted. */
export function GenerateButton({ exhausted, label }: { exhausted: boolean; label?: string }) {
  const { pending } = usePreparePending();
  return <GenerateButtonView exhausted={exhausted} pending={pending} label={label} />;
}
