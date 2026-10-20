/** The only origin the smoke may touch. Allowlist, not denylist: production and previews are never targets. */
export const STAGING_ORIGIN = "https://noteprep.app";

/** Credentials of a throwaway staging user come from the shell; the host can never be overridden. */
export function smokeTarget(env: Record<string, string | undefined>) {
  if (env.SMOKE_TARGET !== "staging") throw new Error("set SMOKE_TARGET=staging");
  const raw = env.SMOKE_BASE_URL === undefined ? STAGING_ORIGIN : env.SMOKE_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SMOKE_BASE_URL must be ${STAGING_ORIGIN}`);
  }
  const exact =
    url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" &&
    url.pathname === "/" && url.search === "" && url.hash === "" && url.hostname === new URL(STAGING_ORIGIN).hostname;
  if (!exact) throw new Error(`SMOKE_BASE_URL must be ${STAGING_ORIGIN}`);
  if (!env.SMOKE_EMAIL || !env.SMOKE_PASSWORD) throw new Error("set SMOKE_EMAIL and SMOKE_PASSWORD (a throwaway staging user)");
  return { baseURL: STAGING_ORIGIN, email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD };
}
