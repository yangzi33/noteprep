import * as React from "react";
import { cn } from "cn";

type TextFieldProps = Omit<React.ComponentProps<"input">, "id" | "className"> & {
  label: string;
  name: string;
  className?: string;
};

/** Labelled text input matching SelectField (min-h-11, border-input, rounded-control, focus ring). */
export function TextField({ label, name, className, ...input }: TextFieldProps) {
  const id = React.useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        name={name}
        {...input}
        className="min-h-11 rounded-control border border-input bg-card px-3 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-action-disabled disabled:text-text-disabled"
      />
    </div>
  );
}
