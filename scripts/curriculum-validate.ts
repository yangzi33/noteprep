import { readDatasetDir, DatasetFileError, findDatasetDirs } from "../src/lib/curriculum/files";
import type { Dataset } from "../src/lib/curriculum/dataset-schema";
import { crossJurisdictionDuplicates, validateCatalogue } from "../src/lib/curriculum/validate-catalogue";
import { datasetHash, validateDataset } from "../src/lib/curriculum/validate-dataset";

// Validates every curriculum dataset directory (anything containing dataset.json) under the given roots, then the
// whole set together (duplicate ids across datasets, one curriculum entered twice, size budget).
// CI runs this on every change; a failing dataset must never reach a database. Cross-jurisdiction duplicate
// courses are printed as a warning only; use `pnpm curriculum:report` for the full citation report.
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["data/curricula", "tests/fixtures/curricula"];

function main() {
  const dirs = roots.flatMap(findDatasetDirs);
  if (dirs.length === 0) {
    console.error("no curriculum datasets found");
    process.exit(1);
  }
  let failed = 0;
  const parsed: Dataset[] = [];
  for (const dir of dirs) {
    try {
      const dataset = readDatasetDir(dir);
      parsed.push(dataset);
      const issues = validateDataset(dataset);
      if (issues.length === 0) {
        console.log(`ok    ${dir}  (${dataset.meta.version.kind}, ${dataset.structure.topics.length} topics, ${datasetHash(dataset).slice(0, 19)})`);
      } else {
        failed++;
        console.log(`FAIL  ${dir}`);
        for (const issue of issues) console.log(`        ${issue.code} at ${issue.where}${issue.detail ? ` (${issue.detail})` : ""}`);
      }
    } catch (error) {
      failed++;
      console.log(`FAIL  ${dir}\n        ${error instanceof DatasetFileError ? error.message : String(error)}`);
    }
  }
  // fixtures under tests/ are deliberately odd (and repeat ids on purpose), so the set-wide rules cover the data roots only
  const dataset = parsed.filter((_, i) => !dirs[i]!.split("/").includes("tests"));
  for (const issue of validateCatalogue(dataset)) {
    failed++;
    console.log(`FAIL  catalogue: ${issue.code} at ${issue.where}${issue.detail ? ` (${issue.detail})` : ""}`);
  }
  const duplicates = crossJurisdictionDuplicates(dataset);
  if (duplicates.length > 0) console.log(`warn  ${duplicates.length} course(s) appear identically in more than one curriculum (see pnpm curriculum:report)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
