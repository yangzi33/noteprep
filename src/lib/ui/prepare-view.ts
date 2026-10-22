import type { CurriculumSummary, SelectionOption, SelectionStep } from "@/lib/server/dal/curriculum";
import type { DatasetKind } from "@/lib/curriculum/dataset-schema";
import { prepareHref, upTo, type PrepareParams } from "@/lib/ui/prepare-url";

export type FieldKey = "country" | "v" | "level" | "course" | "unit" | "topic";

export interface SelectFieldView {
  key: FieldKey;
  label: string;
  value: string;
  options: { value: string; label: string; disabled: boolean }[];
  disabled: boolean;
  placeholder: string;
}

const LABELS: Record<FieldKey, string> = {
  country: "Country",
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
/** Which dataset notice the Prepare page shows: sample and test data, unofficial suggested topics, or none for real data. */
export function datasetBanner(kind: DatasetKind): "sample" | "suggested" | null {
  if (kind === "sample" || kind === "synthetic") return "sample";
  return kind === "suggested" ? "suggested" : null;
}

type CountryCurriculum = Pick<CurriculumSummary, "id" | "name" | "latestVersionId" | "educationSystem" | "versions">;

/** The grouping key of a country: its region code, trimmed and upper-cased. */
export const countryKey = (regionCode: string) => regionCode.trim().toUpperCase();

/**
 * A human label for a country group. A two-letter region code that Intl knows by name ("CA" gives "Canada") uses
 * that name; anything else (an "International" group, sample or test codes, "CA-ON") falls back to the system name.
 */
export function countryLabel(regionCode: string, systemName: string): string {
  const code = countryKey(regionCode);
  if (/^[A-Z]{2}$/.test(code)) {
    try {
      const name = new Intl.DisplayNames("en", { type: "region" }).of(code);
      if (name && name !== code && name !== "Unknown Region") return name;
    } catch {
      // not a valid region code: use the system name
    }
  }
  return systemName;
}

/** The distinct countries among the visible curricula, sorted by label (then code) so the order is stable. */
export function countryOptions(curricula: CountryCurriculum[]): { value: string; label: string }[] {
  const byCode = new Map<string, string>();
  for (const c of curricula) {
    const code = countryKey(c.educationSystem.regionCode);
    const label = countryLabel(code, c.educationSystem.name);
    const known = byCode.get(code);
    if (known === undefined || label.localeCompare(known) < 0) byCode.set(code, label);
  }
  return [...byCode].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

export function curriculaForCountry<T extends Pick<CountryCurriculum, "educationSystem">>(curricula: T[], country: string): T[] {
  return curricula.filter((c) => countryKey(c.educationSystem.regionCode) === countryKey(country));
}

export type CountryResolution = { ok: true; country: string | undefined; showStep: boolean } | { ok: false };

/**
 * The country the page works with. One country: it is selected for the user and no step is shown. Several: the step
 * is shown, the country comes from the URL or is derived from `v`. An unknown country, or a version outside the
 * chosen country, is `ok: false` (the page shows its polite notice). An unknown version is left to the normal lookup.
 */
export function resolveCountry(input: { curricula: CountryCurriculum[]; params: Pick<PrepareParams, "country" | "v"> }): CountryResolution {
  const options = countryOptions(input.curricula);
  const asked = input.params.country ? countryKey(input.params.country) : undefined;
  if (asked !== undefined && !options.some((o) => o.value === asked)) return { ok: false };
  const owner = input.params.v ? input.curricula.find((c) => c.versions.some((v) => v.id === input.params.v)) : undefined;
  const derived = owner ? countryKey(owner.educationSystem.regionCode) : undefined;
  if (asked !== undefined && derived !== undefined && asked !== derived) return { ok: false };
  if (options.length === 1) return { ok: true, country: options[0]!.value, showStep: false };
  return { ok: true, country: asked ?? derived, showStep: true };
}

export function buildSelectFields(input: {
  curricula: CountryCurriculum[] | Pick<CurriculumSummary, "id" | "name" | "latestVersionId">[];
  country?: { showStep: boolean; country: string | undefined };
  params: PrepareParams;
  steps: SelectionStep[];
  stepOptions: Partial<Record<SelectionStep, SelectionOption[]>>;
}): SelectFieldView[] {
  const showCountry = input.country?.showStep === true;
  const country = input.country?.country;
  const all = input.curricula as CountryCurriculum[];
  const curricula = country ? curriculaForCountry(all, country) : showCountry ? [] : all;
  const keys: FieldKey[] = [...(showCountry ? (["country"] as const) : []), "v", ...(input.steps.includes("level") ? (["level"] as const) : []), "course", "unit", "topic"];
  let earlierEmpty = false;
  return keys.map((key) => {
    const value = key === "country" ? (country ?? "") : (input.params[key] ?? "");
    const options =
      key === "country"
        ? countryOptions(all).map((o) => ({ ...o, disabled: false }))
        : key === "v"
        ? curricula.map((c) => ({ value: c.latestVersionId, label: c.name, disabled: false }))
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
