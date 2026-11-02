import { z } from "zod";

export type SignupMode = "open" | "invite";

export interface SignupPolicy {
  mode: SignupMode;
  /** Lower-cased addresses allowed to create an account in invite mode. */
  allowlist: ReadonlySet<string>;
}

const MAX_ENTRIES = 500;
const email = z.email().max(254);

/** Splits a comma, semicolon or whitespace separated list; entries that are not plain email addresses are dropped (they can never grant access). */
export function parseAllowlist(raw: string | undefined): Set<string> {
  const entries = (raw ?? "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && email.safeParse(entry).success);
  return new Set(entries.slice(0, MAX_ENTRIES));
}

/**
 * Invite-only is the default in production builds (fail closed: an unset variable never opens sign-up); development and
 * tests default to open. SIGNUP_MODE=open must be set on purpose to open a production deployment.
 */
export function parseSignupPolicy(source: { NODE_ENV?: string | undefined; SIGNUP_MODE?: string | undefined; SIGNUP_ALLOWLIST?: string | undefined }): SignupPolicy {
  const mode = z.enum(["open", "invite"]).catch(source.NODE_ENV === "production" ? "invite" : "open").parse(source.SIGNUP_MODE || undefined);
  return { mode, allowlist: parseAllowlist(source.SIGNUP_ALLOWLIST) };
}

/** True when this address may create an account under the policy. */
export function mayCreateAccount(policy: SignupPolicy, address: string): boolean {
  return policy.mode === "open" || policy.allowlist.has(address.trim().toLowerCase());
}
