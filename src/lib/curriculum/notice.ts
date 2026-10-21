import type { DatasetKind } from "./dataset-schema";

/**
 * The sentence that explains where a lesson's topic list came from when no alignment is claimed. One wording for the
 * PDF, the draft view and the lesson page, so they cannot drift apart. `name` is the (already escaped, if needed)
 * curriculum name and version label.
 */
export function noClaimOrigin(kind: DatasetKind, name: string): string {
  switch (kind) {
    case "real":
      return "";
    case "suggested":
      return ` The topic list comes from an unofficial NotePrep suggestion for ${name}. It is not an official curriculum and is not endorsed by any curriculum authority.`;
    case "sample":
      return ` It was prepared from sample data (${name}) that is not a real curriculum.`;
    case "synthetic":
      return ` It was prepared from test data (${name}) that is not a real curriculum.`;
  }
}
