import { changesText } from "./draft-changes";

export const versionLabel = (ordinal: number) => `Version ${ordinal}`;

export const CREATE_VERSION_HELP = "Your current version is kept. You can switch back any time.";

/** Visible reason shown when no more versions can be created, or null while there is room. */
export function versionLimitNote(count: number, max: number): string | null {
  return count >= max ? `This draft has ${count} versions, the most allowed (${max}). Switch between them, or start a new draft.` : null;
}

/** Short badge for a version tab: "2 replaced", "1 removed", "2 replaced · 1 removed"; null when the version is unchanged. */
export function changesBadge(summary: { replacedIds: readonly string[]; removedIds: readonly string[] }): string | null {
  const replaced = summary.replacedIds.length;
  const removed = summary.removedIds.length;
  if (replaced === 0 && removed === 0) return null;
  return changesText(replaced, removed)
    .replace(/(\d+) questions? replaced/, "$1 replaced")
    .replace(/(\d+) questions? removed/, "$1 removed");
}
