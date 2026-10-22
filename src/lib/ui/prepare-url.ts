/** The wizard's whole state lives in the URL, so refresh, back and shared links all just work. */
export interface PrepareParams {
  /** Optional UI filter (region code); never decides what is generated or who may see what. */
  country?: string;
  v?: string;
  level?: string;
  course?: string;
  unit?: string;
  topic?: string;
}

export const PREPARE_STEPS = ["country", "v", "level", "course", "unit", "topic"] as const;
export type PrepareStep = (typeof PREPARE_STEPS)[number];

export function prepareHref(params: PrepareParams & { error?: string } = {}): string {
  const q = new URLSearchParams();
  for (const key of [...PREPARE_STEPS, "error"] as const) {
    const value = (params as Record<string, string | undefined>)[key];
    if (value) q.set(key, value);
  }
  const s = q.toString();
  return s ? `/prepare?${s}` : "/prepare";
}

/** The selection up to and including `step`; later choices are dropped (changing an earlier step clears the rest). */
export function upTo(params: PrepareParams, step: PrepareStep): PrepareParams {
  const out: PrepareParams = {};
  for (const key of PREPARE_STEPS) {
    out[key] = params[key];
    if (key === step) break;
  }
  return out;
}

/** Only the known selection params, as plain strings (anything else in the URL is ignored). */
export function readPrepareParams(raw: Record<string, string | string[] | undefined>): PrepareParams & { error?: string } {
  const one = (v: string | string[] | undefined) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);
  return { country: one(raw.country), v: one(raw.v), level: one(raw.level), course: one(raw.course), unit: one(raw.unit), topic: one(raw.topic), error: one(raw.error) };
}
