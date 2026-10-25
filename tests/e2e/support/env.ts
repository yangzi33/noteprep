import { execFileSync } from "node:child_process";

/**
 * The four pinned test servers (playwright.config.ts). Each pins FLOW_MODE and EXPORT_ENABLED explicitly, so a developer's own .env
 * cannot change them: default = draft flow with export on; legacy = the old generate flow; paused = draft flow with export off; daily = draft flow with export on and the beta daily refresh on (limit 5).
 */
export const E2E_URLS = {
  default: "http://127.0.0.1:3100",
  legacy: "http://127.0.0.1:3101",
  paused: "http://127.0.0.1:3102",
  daily: "http://127.0.0.1:3103",
} as const;

export interface E2eEnv {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
  dbUrl: string;
  webUrl: string;
  /** Runtime logins created by scripts/dev-roles.sh (throwaway local credentials). */
  webDatabaseUrl: string;
  workerDatabaseUrl: string;
}

let cached: E2eEnv | undefined;

/** Reads the running local Supabase stack. Start it first with `pnpm supabase:start`. */
export function e2eEnv(): E2eEnv {
  if (cached) return cached;
  let status: Record<string, string>;
  try {
    const out = execFileSync("pnpm", ["-s", "supabase", "status", "-o", "json"], { encoding: "utf8", timeout: 60_000 });
    status = JSON.parse(out.slice(out.indexOf("{")));
  } catch (error) {
    throw new Error(`The local Supabase stack is not running; start it with "pnpm supabase:start". (${String(error)})`);
  }
  const need = (key: string) => {
    const value = status[key];
    if (!value) throw new Error(`supabase status did not report ${key}`);
    return value;
  };
  const dbUrl = need("DB_URL");
  const login = (user: string) => {
    const u = new URL(dbUrl);
    u.username = user;
    u.password = "dev-only-password";
    return u.toString();
  };
  cached = {
    apiUrl: need("API_URL"),
    publishableKey: need("PUBLISHABLE_KEY"),
    secretKey: need("SECRET_KEY"),
    dbUrl,
    webUrl: E2E_URLS.default,
    webDatabaseUrl: login("web_login"),
    workerDatabaseUrl: login("worker_login"),
  };
  return cached;
}
