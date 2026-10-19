import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

// Local compose.yaml database by default (throwaway credentials, localhost only).
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";

export interface TestDbInfo {
  adminUrl: string;
  appUrl: string;
  workerUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    testDb: TestDbInfo;
  }
}

function withDatabase(url: string, database: string, user?: string, password?: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export default async function setup(project: TestProject) {
  const id = randomBytes(4).toString("hex");
  const database = `noteprep_it_${id}`;
  const appRole = `it_app_${id}`;
  const workerRole = `it_worker_${id}`;
  const password = randomBytes(8).toString("hex");

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${new URL(ADMIN_URL).host}. Start it with "pnpm db:up". (${String(error)})`,
    );
  }
  await admin.query(`CREATE DATABASE ${database}`);

  const databaseUrl = withDatabase(ADMIN_URL, database);
  // Real migrations through the real CLI: proves they replay from an empty database.
  await run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl },
    timeout: 110_000,
  });

  // Login users join the NOLOGIN runtime roles created by the migration.
  await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' IN ROLE app_runtime`);
  await admin.query(`CREATE ROLE ${workerRole} LOGIN PASSWORD '${password}' IN ROLE worker_runtime`);

  project.provide("testDb", {
    adminUrl: databaseUrl,
    appUrl: withDatabase(ADMIN_URL, database, appRole, password),
    workerUrl: withDatabase(ADMIN_URL, database, workerRole, password),
  });

  return async () => {
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${appRole}`);
    await admin.query(`DROP ROLE ${workerRole}`);
    await admin.end();
  };
}
