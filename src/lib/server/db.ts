import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { serverEnv } from "./env";

export type Db = PrismaClient;

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForDb = globalThis as unknown as { __noteprepDb?: Db };

/** One client per server process (kept across dev hot reloads). */
export function getDb(): Db {
  globalForDb.__noteprepDb ??= createDb(serverEnv().DATABASE_URL);
  return globalForDb.__noteprepDb;
}
