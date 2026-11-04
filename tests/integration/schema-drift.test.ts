import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, inject } from "vitest";

const run = promisify(execFile);

// The migrations are the source of truth for the database and prisma/schema.prisma describes it for the client: if they
// disagree, the next `prisma migrate dev` generates a migration that drops or renames objects.
describe("prisma schema and SQL migrations agree", () => {
  it("reports no difference between the migrated database and prisma/schema.prisma", async () => {
    const url = inject("testDb").adminUrl;
    const { stdout } = await run(
      "pnpm",
      ["exec", "prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"],
      { env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url }, timeout: 110_000 },
    );
    const sql = stdout.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("Loaded Prisma config") && !/^[│┌└]/.test(line));
    expect(sql.join("\n")).toBe("-- This is an empty migration.");
  }, 120_000);
});
