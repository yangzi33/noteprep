/** Only same-site absolute paths; anything else (scheme, //host, backslashes) falls back to the default. */
export function safeNextPath(next: string | null | undefined, fallback = "/account"): string {
  if (!next || next.length > 200) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
