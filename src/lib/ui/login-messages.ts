const MESSAGES: Record<string, string> = {
  invalid: "Check your email and password (at least 10 characters) and try again.",
  unverified: "Please confirm your email address first.",
  callback: "That confirmation link is invalid or expired.",
  "check-email": "Check your inbox. If this address can be used, we have sent a confirmation link. It can take a few minutes; check your spam folder too.",
};

/** Looks up a login message by its own keys only (never inherited ones like __proto__). */
export function loginMessage(key: string | undefined): string | undefined {
  if (key === undefined || !Object.hasOwn(MESSAGES, key)) return undefined;
  return MESSAGES[key];
}
