import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readDatasetDir, DatasetFileError } from "../src/lib/curriculum/files";
import { datasetHash, validateDataset } from "../src/lib/curriculum/validate-dataset";

// Validates every curriculum dataset directory (anything containing dataset.json) under the given roots.
// CI runs this on every change; a failing dataset must never reach a database.
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["data/curricula", "tests/fixtures/curricula"];

function findDatasetDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  if (existsSync(path.join(root, "dataset.json"))) return [root];
  return readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => statSync(p).isDirectory())
    .flatMap(findDatasetDirs);
}

function main() {
  const dirs = roots.flatMap(findDatasetDirs);
  if (dirs.length === 0) {
    console.error("no curriculum datasets found");
    process.exit(1);
  }
  let failed = 0;
  for (const dir of dirs) {
    try {
      const dataset = readDatasetDir(dir);
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
  process.exit(failed === 0 ? 0 : 1);
}

main();
