import { ManifestIncomplete } from "./errors";

export const EDITIONS = ["student", "teacher"] as const;
export const FORMATS = ["tex", "pdf"] as const;
export type Edition = (typeof EDITIONS)[number];
export type Format = (typeof FORMATS)[number];

export interface ManifestEntry {
  edition: Edition;
  format: Format;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ManifestScope {
  ownerId: string;
  lessonId: string;
  revisionId: string;
  attemptId: string;
}

/** Server-generated object path; user input never participates (docs/architecture.md section 10). */
export function artifactPath(scope: ManifestScope, edition: Edition, format: Format): string {
  return `${scope.ownerId}/${scope.lessonId}/${scope.revisionId}/${scope.attemptId}/${edition}.${format}`;
}

/**
 * A complete lesson pack has exactly four files: student and teacher editions, each as .tex and .pdf,
 * stored under this attempt's own prefix. Anything else must not be published or billed.
 */
export function assertManifestComplete(entries: readonly ManifestEntry[], scope: ManifestScope): void {
  const expected = EDITIONS.flatMap((edition) => FORMATS.map((format) => ({ edition, format })));
  if (entries.length !== expected.length) {
    throw new ManifestIncomplete(`expected ${expected.length} files, got ${entries.length}`);
  }
  for (const { edition, format } of expected) {
    const matches = entries.filter((e) => e.edition === edition && e.format === format);
    const entry = matches[0];
    if (matches.length !== 1 || !entry) throw new ManifestIncomplete(`missing or duplicate ${edition}.${format}`);
    if (entry.path !== artifactPath(scope, edition, format)) {
      throw new ManifestIncomplete(`${edition}.${format} is outside this attempt's prefix`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new ManifestIncomplete(`${edition}.${format} has no valid sha256`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
      throw new ManifestIncomplete(`${edition}.${format} is empty`);
    }
  }
}
