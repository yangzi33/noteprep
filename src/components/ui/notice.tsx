import * as React from "react";
import { CircleAlert, CircleCheck, Info, LoaderCircle } from "lucide-react";
import { cn } from "cn";

type Intent = "error" | "success" | "progress" | "info";

const styles: Record<Intent, string> = {
  error: "border-border-danger bg-danger-surface text-destructive",
  success: "border-border bg-accent text-text-accent",
  progress: "border-border bg-accent text-text-accent",
  info: "border-border bg-accent text-text-accent",
};

const roles: Record<Intent, string> = { error: "alert", success: "status", progress: "status", info: "note" };

const icons = { error: CircleAlert, success: CircleCheck, progress: LoaderCircle, info: Info } as const;

export function Notice({
  intent,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { intent: Intent }) {
  const Icon = icons[intent];
  return (
    <div
      role={roles[intent]}
      className={cn("flex select-text items-start gap-2 rounded-notice border px-4 py-3 text-sm", styles[intent], className)}
      {...props}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", intent === "progress" && "animate-spin motion-reduce:animate-none")} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
