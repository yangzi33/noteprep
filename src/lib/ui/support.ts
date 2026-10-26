const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** A plain email address, trimmed, or null when the value is unset or not a plain address. */
export function parseSupportEmail(raw: string | undefined | null): string | null {
  const value = raw?.trim() ?? "";
  return PLAIN_EMAIL.test(value) ? value : null;
}

const PHRASE = "contact us";

/**
 * Splits a pure text around its first "contact us" so a component can add the address after it.
 * Returns null when the text does not contain the phrase.
 */
export function splitAtContact(text: string): { before: string; phrase: string; after: string } | null {
  const at = text.indexOf(PHRASE);
  if (at < 0) return null;
  return { before: text.slice(0, at), phrase: PHRASE, after: text.slice(at + PHRASE.length) };
}
