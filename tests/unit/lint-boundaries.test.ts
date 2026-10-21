import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
/** ESLint's cold start (loading the config and plugins) can exceed vitest's 5 s default when the suite runs under load. */
const LINT_TIMEOUT = 30_000;

async function ruleIds(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId);
}

describe("architecture boundary lint rules", () => {
  const prismaImport = 'import { PrismaClient } from "@prisma/client";\nexport const c = PrismaClient;\n';
  const envRead = "export const url = process.env.DATABASE_URL;\n";

  it("rejects the database client outside the data access layer", async () => {
    expect(await ruleIds("src/app/page.ts", prismaImport)).toContain("no-restricted-imports");
  }, LINT_TIMEOUT);

  it("allows the database client inside the data access layer", async () => {
    expect(await ruleIds("src/lib/server/dal/lessons.ts", prismaImport)).not.toContain(
      "no-restricted-imports",
    );
  }, LINT_TIMEOUT);

  it("rejects process.env outside the env modules", async () => {
    expect(await ruleIds("src/lib/server/other.ts", envRead)).toContain("no-restricted-properties");
  }, LINT_TIMEOUT);

  it("allows process.env in the env modules", async () => {
    expect(await ruleIds("src/lib/server/env.ts", envRead)).not.toContain("no-restricted-properties");
    expect(await ruleIds("worker/env.ts", envRead)).not.toContain("no-restricted-properties");
  }, LINT_TIMEOUT);
});
