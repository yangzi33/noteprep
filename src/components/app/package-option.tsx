import * as React from "react";
import { Check } from "lucide-react";

type PackageOptionProps = {
  id: string;
  name: string;
  value: string;
  label: string;
  description: string;
  defaultChecked?: boolean;
  disabled?: boolean;
};

export function PackageOption({ id, name, value, label, description, defaultChecked, disabled }: PackageOptionProps) {
  const descId = `${id}-desc`;
  return (
    <div className="relative flex min-h-11 items-start gap-3 rounded-notice border border-input bg-card p-3 has-[:checked]:border-ring has-[:checked]:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <input
        type="checkbox"
        id={id}
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-describedby={descId}
        className="peer mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label
          htmlFor={id}
          className="cursor-pointer text-sm font-medium text-foreground after:absolute after:inset-0 after:content-['']"
        >
          {label}
        </label>
        <p id={descId} className="text-[13px] text-muted-foreground">
          {description}
        </p>
      </div>
      <Check aria-hidden="true" className="invisible size-4 shrink-0 text-text-accent peer-checked:visible" />
    </div>
  );
}
