/** The text for the "Reference" line of an error page: the opaque digest Next.js attaches to a server error, or null. Never the message. */
export function errorReference(digest: unknown): string | null {
  return typeof digest === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(digest) ? `Reference: ${digest}` : null;
}
