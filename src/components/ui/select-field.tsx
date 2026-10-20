import * as React from "react";
import { cn } from "cn";

type SelectOption = { value: string; label: string; disabled?: boolean };

type SelectFieldProps = {
  label: string;
  name: string;
  options: SelectOption[];
  defaultValue?: string;
  hint?: string;
  error?: string;
  id?: string;
  className?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  disabled?: boolean;
  testId?: string;
  placeholder?: string;
};

export function SelectField({ label, name, options, defaultValue, hint, error, id, className, onChange, disabled, testId, placeholder }: SelectFieldProps) {
  const generatedId = React.useId();
  const selectId = id ?? generatedId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={selectId} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <select
        id={selectId}
        name={name}
        defaultValue={defaultValue}
        onChange={onChange}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        className="min-h-11 rounded-control border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-action-disabled disabled:text-text-disabled"
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={hintId} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
