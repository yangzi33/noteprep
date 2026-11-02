const REQUIRED = ["LLM_API_KEY", "LLM_MODEL", "LLM_PRICE_INPUT_MICROS_PER_MTOK", "LLM_PRICE_OUTPUT_MICROS_PER_MTOK"] as const;
const PRICES = ["LLM_PRICE_INPUT_MICROS_PER_MTOK", "LLM_PRICE_OUTPUT_MICROS_PER_MTOK"] as const;

export interface RealProviderSettings {
  LLM_PROVIDER: string;
  LLM_API_KEY?: string | undefined;
  LLM_MODEL?: string | undefined;
  LLM_PRICE_INPUT_MICROS_PER_MTOK?: number | undefined;
  LLM_PRICE_OUTPUT_MICROS_PER_MTOK?: number | undefined;
}

/**
 * Operator-facing problems with the configuration of any provider other than the fake one (so a future provider inherits
 * the checks). A zero price is refused: it makes every cost cap and spend alert blind. Names only, never values.
 */
export function realProviderConfigIssues(settings: RealProviderSettings): string[] {
  if (settings.LLM_PROVIDER === "fake") return [];
  const missing = REQUIRED.filter((k) => settings[k] === undefined);
  const free = PRICES.filter((k) => settings[k] === 0);
  return [
    ...(missing.length > 0 ? [`LLM_PROVIDER=${settings.LLM_PROVIDER} also needs: ${missing.join(", ")}`] : []),
    ...(free.length > 0 ? [`${free.join(", ")} must be above 0 for a real provider: a zero price makes every cost cap and spend alert blind`] : []),
  ];
}
