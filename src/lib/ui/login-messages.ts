const MESSAGES: Record<string, string> = {
  invalid: "Check your email and password (at least 10 characters) and try again.",
  unverified: "Please confirm your email address first.",
  callback: "That confirmation link is invalid or expired.",
  "check-email": "If the address can be used, a confirmation email is on its way.",
};

/** Looks up a login message by its own keys only (never inherited ones like __proto__). */
export function loginMessage(key: string | undefined): string | undefined {
  if (key === undefined || !Object.hasOwn(MESSAGES, key)) return undefined;
  return MESSAGES[key];
}
