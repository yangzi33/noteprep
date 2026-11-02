import { z } from "zod";

export type SignupMode = "open" | "invite";

export interface SignupPolicy {
  mode: SignupMode;
  /** Lower-cased addresses allowed to create an account in invite mode. */
  allowlist: ReadonlySet<string>;
}

const MAX_ENTRIES = 500;
const email = z.email().max(254);

export interface AllowlistReport {
  allowlist: Set<string>;
  /** Entries that are not plain email addresses (never counted as duplicates). */
  invalid: number;
  /** Valid entries repeating an earlier one (case-insensitive). */
  duplicate: number;
  /** Distinct valid entries beyond the cap. */
  overCap: number;
}

/** Splits a comma, semicolon or whitespace separated list; entries that are not plain email addresses are dropped (they can never grant access). Duplicates are removed before the cap applies. */
export function readAllowlist(raw: string | undefined): AllowlistReport {
  const allowlist = new Set<string>();
  let invalid = 0;
  let duplicate = 0;
  let overCap = 0;
  for (const token of (raw ?? "").split(/[\s,;]+/)) {
    const entry = token.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (!email.safeParse(entry).success) invalid += 1;
    else if (allowlist.has(entry)) duplicate += 1;
    else if (allowlist.size >= MAX_ENTRIES) overCap += 1;
    else allowlist.add(entry);
  }
  return { allowlist, invalid, duplicate, overCap };
}

export function parseAllowlist(raw: string | undefined): Set<string> {
  return readAllowlist(raw).allowlist;
}

/**
 * Invite-only is the default everywhere except an explicit development or test run (fail closed: an unset, empty or
 * unrecognised variable, or an unset NODE_ENV, never opens sign-up). SIGNUP_MODE=open must be set on purpose to open a
 * production deployment. Only the exact strings "open" and "invite" are recognised.
 */
export function parseSignupPolicy(source: { NODE_ENV?: string | undefined; SIGNUP_MODE?: string | undefined; SIGNUP_ALLOWLIST?: string | undefined }): SignupPolicy {
  const explicit = source.SIGNUP_MODE;
  const mode: SignupMode =
    explicit === "open" || explicit === "invite" ? explicit : !explicit && (source.NODE_ENV === "development" || source.NODE_ENV === "test") ? "open" : "invite";
  return { mode, allowlist: readAllowlist(source.SIGNUP_ALLOWLIST).allowlist };
}

/** True when this address may create an account under the policy. */
export function mayCreateAccount(policy: SignupPolicy, address: string): boolean {
  return policy.mode === "open" || policy.allowlist.has(address.trim().toLowerCase());
}
