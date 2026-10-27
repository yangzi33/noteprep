const MESSAGES: Record<string, string> = {
  invalid: "Check your email and password (at least 10 characters) and try again.",
  unverified: "Please confirm your email address first.",
  callback: "That confirmation link is invalid or expired.",
  recovery: "That password reset link is invalid or expired. Request a new one.",
  "reset-sent": "Check your inbox. If this address has an account, we have sent a link to reset your password. It can take a few minutes; check your spam folder too.",
  "check-email": "Check your inbox. If this address can be used, we have sent a confirmation link. It can take a few minutes; check your spam folder too.",
};

/** Looks up a login message by its own keys only (never inherited ones like __proto__). */
export function loginMessage(key: string | undefined): string | undefined {
  if (key === undefined || !Object.hasOwn(MESSAGES, key)) return undefined;
  return MESSAGES[key];
}

const PASSWORD_MESSAGES: Record<string, string> = {
  invalid: "Use a password of 10 to 72 characters.",
  mismatch: "The two passwords do not match.",
  failed: "We could not update your password. Request a new reset link and try again.",
};
const ACCOUNT_NOTICES: Record<string, string> = { "password-updated": "Your password has been updated." };

/** Error text of the set-a-new-password page, by its own allowlisted keys only. */
export function passwordMessage(key: string | undefined): string | undefined {
  if (key === undefined || !Object.hasOwn(PASSWORD_MESSAGES, key)) return undefined;
  return PASSWORD_MESSAGES[key];
}

/** Confirmation shown on the account page, by its own allowlisted keys only. */
export function accountNotice(key: string | undefined): string | undefined {
  if (key === undefined || !Object.hasOwn(ACCOUNT_NOTICES, key)) return undefined;
  return ACCOUNT_NOTICES[key];
}
