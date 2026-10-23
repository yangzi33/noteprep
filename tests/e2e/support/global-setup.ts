import { execFileSync } from "node:child_process";
import pg from "pg";
import { e2eEnv } from "./env";
import { assertLocalDatabase } from "./local-db";

// Applies the real migrations to the local Supabase database, makes sure the runtime logins exist, and
// parks jobs left over from earlier local runs so this run's worker only sees its own.
export default async function globalSetup() {
  const env = e2eEnv();
  assertLocalDatabase(env.dbUrl); // before anything below edits rows
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
  // Pending exports left by an earlier run must be settled as a unit (export, job, reservation, bucket counter): a deferred
  // consistency trigger refuses a job cancel that leaves a pending export behind.
  await db.query("BEGIN");
  // Several pending reservations may share one bucket: decrement by the count per bucket, not once per joined row.
  await db.query(
    `UPDATE usage_bucket b SET reserved = b.reserved - x.n
       FROM (SELECT r.bucket_id, count(*)::int AS n
               FROM usage_reservation r JOIN export e ON e.job_id = r.job_id
              WHERE e.state = 'pending' AND r.state = 'reserved' GROUP BY r.bucket_id) x
      WHERE x.bucket_id = b.id`,
  );
  await db.query(
    `UPDATE usage_reservation r SET state = 'released', settle_reason = 'e2e_cleanup', settled_at = now()
       FROM export e WHERE e.job_id = r.job_id AND e.state = 'pending' AND r.state = 'reserved'`,
  );
  await db.query(
    `UPDATE generation_job j SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'e2e_cleanup', finished_at = COALESCE(j.finished_at, now())
       FROM export e WHERE e.job_id = j.id AND e.state = 'pending'`,
  );
  await db.query(`UPDATE export SET state = 'failed', failure_code = 'e2e_cleanup', settled_at = now() WHERE state = 'pending'`);
  await db.query("COMMIT");
  await db.query(
    `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'e2e_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`,
  );
  await db.end();
}
