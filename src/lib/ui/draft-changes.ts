const plural = (n: number) => `${n} question${n === 1 ? "" : "s"}`;

/** "3 questions replaced · 1 removed", "1 question removed", or "No changes yet": zero parts are left out. */
export function changesText(replaced: number, removed: number): string {
  if (replaced > 0 && removed > 0) return `${plural(replaced)} replaced · ${removed} removed`;
  if (replaced > 0) return `${plural(replaced)} replaced`;
  if (removed > 0) return `${plural(removed)} removed`;
  return "No changes yet";
}
