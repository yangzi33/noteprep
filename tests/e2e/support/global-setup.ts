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

  // The labelled sample curriculum, loaded on the owner connection (the runtime roles cannot write it).
  execFileSync("pnpm", ["-s", "curriculum:load", "data/curricula/sample-math/sample-1", "--allow-sample"], {
    env: { ...process.env, MIGRATION_DATABASE_URL: env.dbUrl, CURRICULUM_TARGET_ENV: "development" },
    stdio: "pipe",
    timeout: 60_000,
  });

  const db = new pg.Client({ connectionString: env.dbUrl });
  await db.connect();
  // The tests start their own worker on this database. A worker you left running (pnpm worker:dev) would claim
  // the tests' jobs with its own settings, and the failures would look unrelated. Fail early and say why.
  const { rows: others } = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'worker_login' AND pid <> pg_backend_pid()`);
  if (others[0].n > 0) {
    await db.end();
    throw new Error(`${others[0].n} connection(s) from another worker are open on this database. Stop "pnpm worker:dev" before running the e2e tests: they share the local database and that worker would take the tests' jobs.`);
  }
  await db.query(
    `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'e2e_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`,
  );
  await db.end();
}
