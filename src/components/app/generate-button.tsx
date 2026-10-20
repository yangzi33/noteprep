"use client";

import { Button } from "@/components/ui/button";
import { usePreparePending } from "@/components/app/prepare-pending";

export function GenerateButtonView({ exhausted, pending }: { exhausted: boolean; pending: boolean }) {
  return (
    <Button type="submit" disabled={exhausted || pending} aria-busy={pending ? "true" : undefined} className="w-full">
      Generate lesson
    </Button>
  );
}

/** Disabled while a dropdown change is navigating, so the form's stale hidden topic cannot be submitted. */
export function GenerateButton({ exhausted }: { exhausted: boolean }) {
  const { pending } = usePreparePending();
  return <GenerateButtonView exhausted={exhausted} pending={pending} />;
}
