import { execFileSync } from "node:child_process";
import pg from "pg";
import { e2eEnv } from "./env";

// Applies the real migrations to the local Supabase database, makes sure the runtime logins exist, and
// parks jobs left over from earlier local runs so this run's worker only sees its own.
export default async function globalSetup() {
  const env = e2eEnv();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: env.dbUrl, MIGRATION_DATABASE_URL: env.dbUrl },
    stdio: "pipe",
    timeout: 110_000,
  });
  execFileSync("bash", ["scripts/dev-roles.sh"], { stdio: "pipe", timeout: 60_000 });

  const db = new pg.Client({ connectionString: env.dbUrl });
  await db.connect();
  await db.query(
    `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'e2e_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`,
  );
  await db.end();
}
