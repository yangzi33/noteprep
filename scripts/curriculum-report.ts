import { DatasetFileError, findDatasetDirs, readDatasetDir } from "../src/lib/curriculum/files";
import type { Dataset } from "../src/lib/curriculum/dataset-schema";
import { crossJurisdictionDuplicates, provenanceReport, sumCounts } from "../src/lib/curriculum/validate-catalogue";

// Usage: pnpm curriculum:report [--json] [--list-duplicates] [--fail-on-low]
// Reports how many curriculum records (levels, courses, units, topics) carry a citation, how confident those citations
// are, which records are low-confidence, and which courses repeat across jurisdictions. Read-only; exits non-zero only
// with --fail-on-low and at least one low-confidence record, or when a dataset cannot be read.
const args = process.argv.slice(2);
const json = args.includes("--json");
const listDuplicates = args.includes("--list-duplicates");
const failOnLow = args.includes("--fail-on-low");

function main() {
  const datasets: Dataset[] = [];
  for (const dir of findDatasetDirs("data/curricula")) {
    try {
      datasets.push(readDatasetDir(dir));
    } catch (error) {
      console.error(`unreadable dataset: ${error instanceof DatasetFileError ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  const reports = datasets.map(provenanceReport);
  const totals = sumCounts(reports);
  const duplicates = crossJurisdictionDuplicates(datasets);
  const low = reports.flatMap((r) => r.lowConfidence.map((l) => ({ versionId: r.versionId, ...l })));

  if (json) {
    console.log(JSON.stringify({ totals, perVersion: reports.map((r) => ({ versionId: r.versionId, ...r.records })), lowConfidence: low, duplicateCourses: duplicates }, null, 2));
  } else {
    console.log(`datasets: ${datasets.length}`);
    console.log(`records: ${totals.total} (sourced ${totals.sourced}, unsourced ${totals.unsourced})`);
    console.log(`confidence of sourced records: high ${totals.high}, medium ${totals.medium}, low ${totals.low}, unrated ${totals.unrated}`);
    const worst = reports.filter((r) => r.records.unsourced > 0 || r.records.low > 0).length;
    console.log(`versions with unsourced or low-confidence records: ${worst} of ${reports.length}`);
    for (const l of low) console.log(`low   ${l.versionId}  ${l.kind} ${l.id}  "${l.title}"  ${l.sourceUrl ?? ""}`);
    console.log(`courses repeated identically across curricula: ${duplicates.length}`);
    if (listDuplicates) for (const d of duplicates) console.log(`dup   ${d.curricula.join(", ")}  |  ${d.fingerprint.split("#")[0]}`);
  }
  if (failOnLow && totals.low > 0) process.exit(1);
}

main();
