import { z } from "zod";

const Token = z.string().min(1).max(512).regex(/^[A-Za-z0-9._~-]+$/);

export type RecoveryParams = { kind: "token_hash"; value: string } | { kind: "code"; value: string } | null;

/** Shape-only validation of the reset link parameters; the token itself is checked by the provider on POST. */
export function parseRecoveryParams(input: { token_hash?: unknown; type?: unknown; code?: unknown }): RecoveryParams {
  const hash = Token.safeParse(input.token_hash);
  if (hash.success && input.type === "recovery") return { kind: "token_hash", value: hash.data };
  // A token_hash that is present but unusable does not fall back to the code.
  if (input.token_hash !== undefined && input.token_hash !== null) return null;
  const code = Token.safeParse(input.code);
  return code.success ? { kind: "code", value: code.data } : null;
}
