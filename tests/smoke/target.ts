/** Where the staging smoke may run. Production is never a target; the throwaway user's credentials come from the shell. */
export function smokeTarget(env: Record<string, string | undefined>) {
  if (env.SMOKE_TARGET !== "staging") throw new Error("set SMOKE_TARGET=staging");
  const url = new URL(env.SMOKE_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".vercel.app")) throw new Error("SMOKE_BASE_URL must be the https staging domain");
  if (!env.SMOKE_EMAIL || !env.SMOKE_PASSWORD) throw new Error("set SMOKE_EMAIL and SMOKE_PASSWORD (a throwaway staging user)");
  return { baseURL: url.origin, email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD };
}
