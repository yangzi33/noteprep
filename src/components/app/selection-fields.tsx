"use client";

import { useRouter } from "next/navigation";
import { SelectField } from "@/components/ui/select-field";
import type { PrepareParams } from "@/lib/ui/prepare-url";
import { selectionHref, type SelectFieldView } from "@/lib/ui/prepare-view";

/** Cascading selects; changing one navigates so the URL (and server-rendered options) stay the source of truth. */
export function SelectionFields({ fields, params }: { fields: SelectFieldView[]; params: PrepareParams }) {
  const router = useRouter();
  const hasLevel = fields.some((f) => f.key === "level");
  const renderField = (field: SelectFieldView) => (
    <SelectField
      key={`${field.key}:${field.value}`}
      label={field.label}
      name={field.key}
      defaultValue={field.value}
      placeholder={field.placeholder}
      disabled={field.disabled}
      options={field.options}
      testId={`select-${field.key}`}
      onChange={(event) => router.push(selectionHref(params, field.key, event.target.value))}
    />
  );
  const row = fields.filter((f) => f.key === "v" || f.key === "level" || f.key === "course");
  const rest = fields.filter((f) => f.key === "unit" || f.key === "topic");
  return (
    <div data-testid="selection-fields" className="flex flex-col gap-4">
      <div className={hasLevel ? "grid gap-4 sm:grid-cols-3" : "grid gap-4 sm:grid-cols-2"}>{row.map(renderField)}</div>
      {rest.map(renderField)}
    </div>
  );
}
