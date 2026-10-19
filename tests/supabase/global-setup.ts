import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

export interface SupabaseTestEnv {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
  legacyJwtSecret: string;
  legacyAnonKey: string;
  legacyServiceRoleKey: string;
  dbUrl: string;
  appUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    supabase: SupabaseTestEnv;
  }
}

export default async function setup(project: TestProject) {
  let status: Record<string, string>;
  try {
    const { stdout } = await run("pnpm", ["-s", "supabase", "status", "-o", "json"], { timeout: 60_000 });
    status = JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch (error) {
    throw new Error(`The local Supabase stack is not running. Start it with "pnpm supabase:start". (${String(error)})`);
  }
  const need = (key: string) => {
    const value = status[key];
    if (!value) throw new Error(`supabase status did not report ${key}`);
    return value;
  };
  const dbUrl = need("DB_URL");

  // Apply the real migrations to the Supabase database (a no-op when already applied).
  await run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: dbUrl, MIGRATION_DATABASE_URL: dbUrl },
    timeout: 110_000,
  });

  // A temporary app_runtime login for this run.
  const id = randomBytes(4).toString("hex");
  const appRole = `sb_app_${id}`;
  const password = randomBytes(8).toString("hex");
  const admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' IN ROLE app_runtime`);
  const u = new URL(dbUrl);
  u.username = appRole;
  u.password = password;

  project.provide("supabase", {
    apiUrl: need("API_URL"),
    publishableKey: need("PUBLISHABLE_KEY"),
    secretKey: need("SECRET_KEY"),
    legacyJwtSecret: need("JWT_SECRET"),
    legacyAnonKey: need("ANON_KEY"),
    legacyServiceRoleKey: need("SERVICE_ROLE_KEY"),
    dbUrl,
    appUrl: u.toString(),
  });

  return async () => {
    await admin.query(`DROP ROLE ${appRole}`);
    await admin.end();
  };
}
