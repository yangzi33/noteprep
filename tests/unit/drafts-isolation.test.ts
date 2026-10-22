import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drafts are free: the draft DAL must not be able to reserve, consume or release allowance, or queue jobs.
// This pins it at the source level: what the module imports, and which tables its SQL names.
const source = readFileSync(new URL("../../src/lib/server/dal/drafts.ts", import.meta.url), "utf8");
const FORBIDDEN_IMPORTS = ["reservation", "settlement", "allowance-source", "jobs", "generation", "history"];
const FORBIDDEN_TABLES = ["usage_bucket", "usage_reservation", "generation_job", "usageBucket", "usageReservation", "generationJob", "subscription"];

describe("the draft module is isolated from allowance code", () => {
  const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]!);

  it("imports nothing from reservation, settlement, allowance, job or generation code", () => {
    expect(imports.length).toBeGreaterThan(5);
    // sibling DAL modules by name; "@/lib/domain/generation" is allowed for its IdempotencyKeySchema only (no allowance code in it)
    for (const spec of imports.filter((s) => s.startsWith("./") || s.startsWith("../"))) {
      expect(FORBIDDEN_IMPORTS, spec).not.toContain(spec.split("/").pop()!);
    }
    expect(imports.filter((s) => /reservation|settlement|allowance|\/jobs$|history/.test(s))).toEqual([]);
  });

  it("never names an allowance, reservation, job or subscription table", () => {
    for (const name of FORBIDDEN_TABLES) expect(source, name).not.toContain(name);
  });

  it("the helpers it shares with generation (context, rate limit) do not import reservation code either", () => {
    for (const file of ["request-context.ts", "rate-limit.ts"]) {
      const text = readFileSync(new URL(`../../src/lib/server/dal/${file}`, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/reservation|settlement|allowance/);
    }
  });
});
