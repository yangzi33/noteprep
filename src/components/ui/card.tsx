import * as React from "react";
import { cn } from "cn";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-card border border-border bg-card", className)} {...props} />;
}
