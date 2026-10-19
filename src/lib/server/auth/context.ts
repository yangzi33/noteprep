import "server-only";

declare const authed: unique symbol;

/**
 * Proof that the caller's identity was verified on the server. The only legitimate producer is
 * requireUser() (P1-T5); DAL functions take this instead of a bare user id, so a browser-supplied
 * id cannot reach a query by accident.
 */
export interface AuthedCtx {
  readonly userId: string;
  readonly [authed]: true;
}

/** Do not call outside the server-side auth module (and tests). */
export function makeAuthedCtx(verifiedUserId: string): AuthedCtx {
  return { userId: verifiedUserId } as AuthedCtx;
}
