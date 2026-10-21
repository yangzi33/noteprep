import * as React from "react";
import { cn } from "cn";

type CheckboxRowProps = {
  name: string;
  label: string;
  value?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
  className?: string;
};

export function CheckboxRow({ name, label, value, defaultChecked, disabled, className }: CheckboxRowProps) {
  return (
    <label
      className={cn(
        "flex min-h-11 items-center gap-3 text-sm text-foreground",
        disabled ? "cursor-not-allowed text-text-disabled" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span>{label}</span>
    </label>
  );
}
