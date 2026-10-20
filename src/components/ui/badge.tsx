import * as React from "react";
import { cn } from "cn";

type BadgeProps = React.ComponentProps<"span"> & { tone?: "accent" | "neutral" };

const tones = {
  accent: "bg-accent text-text-accent",
  neutral: "bg-secondary text-muted-foreground",
} as const;

export function Badge({ tone = "accent", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn("inline-flex items-center rounded-tag px-[9px] py-[5px] text-[11px] font-medium", tones[tone], className)}
      {...props}
    />
  );
}
