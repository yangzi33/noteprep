const plural = (n: number) => `${n} question${n === 1 ? "" : "s"}`;

/** "2 questions added · 3 replaced · 1 removed", "1 question removed", or "No changes yet": zero parts are left out; the first part names the noun. */
export function changesText(replaced: number, removed: number, added = 0): string {
  const parts: [number, string][] = [
    [added, "added"],
    [replaced, "replaced"],
    [removed, "removed"],
  ];
  const shown = parts.filter(([n]) => n > 0);
  if (shown.length === 0) return "No changes yet";
  return shown.map(([n, word], i) => (i === 0 ? `${plural(n)} ${word}` : `${n} ${word}`)).join(" · ");
}
