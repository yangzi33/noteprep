import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatasetFileError, findDatasetDirs, readDatasetDir } from "../src/lib/curriculum/files";
import { buildSourceIndex, findCopiedWording, MAX_SHARED_RUN } from "../src/lib/curriculum/wording-overlap";

// Usage: pnpm curriculum:overlap-check --sources <file-or-dir> [--sources <file-or-dir> ...] [dataset-dir ...]
// Checks that no topic's title and summary, read together, repeat more than MAX_SHARED_RUN consecutive words of the
// given source texts (D-75: our own wording). The sources are plain-text extracts kept outside the repository; this reads
// them, never fetches. Datasets default to everything under data/curricula. Exits 1 on any hit or unreadable input.
const args = process.argv.slice(2);
const sourcePaths: string[] = [];
const datasetRoots: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sources") {
    const next = args[++i];
    if (next === undefined) fail("--sources needs a file or directory");
    sourcePaths.push(next);
  } else datasetRoots.push(args[i]!);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sourceFiles(p: string): string[] {
  let stat;
  try {
    stat = statSync(p);
  } catch {
    return fail(`cannot read sources path: ${p}`);
  }
  if (!stat.isDirectory()) return [p];
  return readdirSync(p, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

function main() {
  if (sourcePaths.length === 0) fail("usage: pnpm curriculum:overlap-check --sources <file-or-dir> [dataset-dir ...]");
  const files = sourcePaths.flatMap(sourceFiles);
  if (files.length === 0) fail("no .txt or .md source files found");
  const index = buildSourceIndex(files.map((f) => readFileSync(f, "utf8")));
  const dirs = (datasetRoots.length ? datasetRoots : ["data/curricula"]).flatMap(findDatasetDirs);
  if (dirs.length === 0) fail("no curriculum datasets found");
  let hits = 0;
  for (const dir of dirs) {
    try {
      for (const hit of findCopiedWording(readDatasetDir(dir), index)) {
        hits++;
        console.log(`COPY  ${dir}  ${hit.id}  "${hit.title}"  ${hit.run} consecutive words (limit ${MAX_SHARED_RUN})`);
      }
    } catch (error) {
      fail(`unreadable dataset: ${error instanceof DatasetFileError ? error.message : String(error)}`);
    }
  }
  console.log(`checked ${dirs.length} dataset(s) against ${files.length} source file(s): ${hits} topic(s) over the limit`);
  if (hits > 0) process.exit(1);
}

main();
