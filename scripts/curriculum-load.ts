import path from "node:path";
import { readDatasetDir } from "../src/lib/curriculum/files";
import { createDb } from "../src/lib/server/db";
import { DatasetRejected, loadDataset, resolveLoadTarget } from "../src/lib/server/curriculum/load";

// Usage: pnpm curriculum:load <dataset dir> [--allow-sample]
// Runs on the OWNER connection (MIGRATION_DATABASE_URL), never the runtime one: the runtime roles cannot
// write curriculum tables. Sample datasets need --allow-sample, which is refused when CURRICULUM_TARGET_ENV
// is production (production|staging|development); --allow-sample requires it set explicitly.
async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: curriculum:load <dataset dir> [--allow-sample]");
    process.exit(2);
  }
  const allowSample = args.includes("--allow-sample");
  const target = resolveLoadTarget(process.env.CURRICULUM_TARGET_ENV, allowSample);
  if (!target.ok) {
    console.error(target.error);
    process.exit(2);
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL (the owner connection) is not set");
    process.exit(2);
  }
  const db = createDb(url);
  try {
    const dataset = readDatasetDir(path.resolve(dir));
    const result = await loadDataset(db, dataset, { allowSample });
    console.log(`${result.outcome}: ${result.versionId}`);
  } catch (error) {
    if (error instanceof DatasetRejected) {
      console.error(`rejected (${error.code}): ${error.message}`);
      for (const issue of error.issues) console.error(`  ${issue.code} at ${issue.where}${issue.detail ? ` (${issue.detail})` : ""}`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
