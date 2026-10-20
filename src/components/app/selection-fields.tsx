"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { usePreparePending } from "@/components/app/prepare-pending";
import { SelectField } from "@/components/ui/select-field";
import type { PrepareParams } from "@/lib/ui/prepare-url";
import { selectionHref, type SelectFieldView } from "@/lib/ui/prepare-view";

const valuesOf = (fields: SelectFieldView[]) => Object.fromEntries(fields.map((f) => [f.key, f.value]));

/** Cascading selects; changing one navigates so the URL (and server-rendered options) stay the source of truth. */
export function SelectionFields({ fields, params }: { fields: SelectFieldView[]; params: PrepareParams }) {
  const router = useRouter();
  const { pending, start } = usePreparePending();
  const hydrated = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [values, setValues] = React.useState<Record<string, string>>(() => valuesOf(fields));
  // Re-sync from the server-rendered values when they change, and whenever a navigation ends (also if it failed).
  const serverValues = JSON.stringify(valuesOf(fields));
  const syncKey = `${pending}|${serverValues}`;
  const [seenKey, setSeenKey] = React.useState(syncKey);
  if (seenKey !== syncKey) {
    setSeenKey(syncKey);
    if (!pending) setValues(JSON.parse(serverValues) as Record<string, string>);
  }

  const hasLevel = fields.some((f) => f.key === "level");
  const renderField = (field: SelectFieldView) => (
    <SelectField
      key={field.key}
      label={field.label}
      name={field.key}
      value={values[field.key] ?? field.value}
      placeholder={field.placeholder}
      disabled={field.disabled}
      options={field.options}
      testId={`select-${field.key}`}
      onChange={(event) => {
        const next = event.target.value;
        setValues((current) => ({ ...current, [field.key]: next }));
        start(() => router.push(selectionHref(params, field.key, next), { scroll: false }));
      }}
    />
  );
  const row = fields.filter((f) => f.key === "v" || f.key === "level" || f.key === "course");
  const rest = fields.filter((f) => f.key === "unit" || f.key === "topic");
  return (
    <div data-testid="selection-fields" data-hydrated={hydrated ? "true" : undefined} className="flex flex-col gap-4">
      <div className={hasLevel ? "grid gap-4 sm:grid-cols-3" : "grid gap-4 sm:grid-cols-2"}>{row.map(renderField)}</div>
      {rest.map(renderField)}
    </div>
  );
}
