import type { CurriculumSummary, SelectionOption, SelectionStep } from "@/lib/server/dal/curriculum";
import { prepareHref, upTo, type PrepareParams } from "@/lib/ui/prepare-url";

export type FieldKey = "v" | "level" | "course" | "unit" | "topic";

export interface SelectFieldView {
  key: FieldKey;
  label: string;
  value: string;
  options: { value: string; label: string; disabled: boolean }[];
  disabled: boolean;
  placeholder: string;
}

const LABELS: Record<FieldKey, string> = {
  v: "Curriculum",
  level: "Level",
  course: "Course",
  unit: "Unit",
  topic: "Topic",
};

function toOption(key: FieldKey, o: SelectionOption): SelectFieldView["options"][number] {
  let label = o.label;
  if (key === "topic" && o.coverage === "partial") label += " (partly covered)";
  if (!o.supported) label += key === "topic" ? " — not available yet" : " — nothing here is available yet";
  return { value: o.id, label, disabled: !o.supported };
}

/** The cascading selects for the prepare form. A field is disabled until every field before it has a value. */
export function buildSelectFields(input: {
  curricula: Pick<CurriculumSummary, "id" | "name" | "latestVersionId">[];
  params: PrepareParams;
  steps: SelectionStep[];
  stepOptions: Partial<Record<SelectionStep, SelectionOption[]>>;
}): SelectFieldView[] {
  const keys: FieldKey[] = ["v", ...(input.steps.includes("level") ? (["level"] as const) : []), "course", "unit", "topic"];
  let earlierEmpty = false;
  return keys.map((key) => {
    const value = input.params[key] ?? "";
    const options =
      key === "v"
        ? input.curricula.map((c) => ({ value: c.latestVersionId, label: c.name, disabled: false }))
        : (input.stepOptions[key] ?? []).map((o) => toOption(key, o));
    const field: SelectFieldView = {
      key,
      label: LABELS[key],
      value,
      options,
      disabled: earlierEmpty,
      placeholder: `Choose a ${LABELS[key].toLowerCase()}`,
    };
    if (value === "") earlierEmpty = true;
    return field;
  });
}

/** The new selection after changing one field: every later value is cleared so no stale topic can be submitted. */
export function changeSelection(params: PrepareParams, key: FieldKey, value: string): PrepareParams {
  return { ...upTo(params, key), [key]: value || undefined };
}

export function selectionHref(params: PrepareParams, key: FieldKey, value: string): string {
  return prepareHref(changeSelection(params, key, value));
}
