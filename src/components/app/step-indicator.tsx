import * as React from "react";
import { cn } from "cn";

/** The tutor flow, shared by Prepare, the draft page and the export page. */
export const FLOW_STEPS = ["Select", "Preview", "Adjust", "Export"] as const;

type StepIndicatorProps = {
  steps: readonly string[];
  current: number;
};

// Presentational progress row, not navigation.
export function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <ol aria-label="Progress" className="flex flex-wrap gap-2 text-[13px]">
      {steps.map((label, i) => (
        <li
          key={label}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "rounded-tag px-3 py-1.5",
            i === current ? "bg-accent text-text-accent font-semibold" : "text-muted-foreground",
          )}
        >
          {`${i + 1} ${label}`}
        </li>
      ))}
    </ol>
  );
}
