import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isEmailConfirmed, verifyClaims } from "@/lib/server/auth/verify";
import {
  TEST_PASSWORD,
  adminClient,
  anonClient,
  createConfirmedUser,
  decodePayload,
  deleteCreatedUsers,
  env,
  forgeHs256,
} from "./helpers";

afterAll(deleteCreatedUsers);

describe("verifying identity from a JWT (real Supabase Auth)", () => {
  it("accepts a genuine session token and returns the verified user id", async () => {
    const user = await createConfirmedUser();
    expect(await verifyClaims(anonClient(), user.accessToken)).toEqual({ userId: user.id, email: user.email });
  });

  it("rejects a token whose payload was tampered with (signature no longer matches)", async () => {
    const [victim, attacker] = await Promise.all([createConfirmedUser(), createConfirmedUser()]);
    const [head, , sig] = attacker.accessToken.split(".");
    const payload = { ...decodePayload(attacker.accessToken), sub: victim.id };
    const forged = `${head}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(await verifyClaims(anonClient(), forged)).toBeNull();
  });

  it("rejects garbage, empty and truncated tokens", async () => {
    const user = await createConfirmedUser();
    for (const bad of ["", "not-a-jwt", "a.b.c", user.accessToken.slice(0, -10), `${user.accessToken}x`]) {
      expect(await verifyClaims(anonClient(), bad)).toBeNull();
    }
  });

  it("rejects an HS256 token forged with the shared legacy secret, even for a real user id", async () => {
    const user = await createConfirmedUser();
    const forged = forgeHs256(env().legacyJwtSecret, { ...decodePayload(user.accessToken), exp: Math.floor(Date.now() / 1000) + 3600 });
    // The Auth server itself still honours this token while the legacy secret is active ...
    const { data } = await anonClient().auth.getUser(forged);
    expect(data.user?.id).toBe(user.id);
    // ... which is why our verification refuses symmetric algorithms outright.
    expect(await verifyClaims(anonClient(), forged)).toBeNull();
  });

  it("rejects the project API keys used as bearer tokens (anon and service role)", async () => {
    expect(await verifyClaims(anonClient(), env().legacyAnonKey)).toBeNull();
    expect(await verifyClaims(anonClient(), env().legacyServiceRoleKey)).toBeNull();
  });

  it("an access token stays verifiable after sign-out until it expires, so sensitive paths use getUser", async () => {
    const user = await createConfirmedUser();
    const client = anonClient();
    const { data } = await client.auth.signInWithPassword({ email: user.email, password: TEST_PASSWORD });
    const token = data.session?.access_token ?? "";
    await client.auth.signOut({ scope: "global" });
    expect(await verifyClaims(anonClient(), token)).not.toBeNull(); // local signature check only
    const { data: server } = await anonClient().auth.getUser(token);
    expect(server.user).toBeNull(); // the Auth server knows the session was revoked
  });
});

describe("sign-up policy", () => {
  it("a new sign-up has no session and cannot sign in until the email is confirmed", async () => {
    const email = `new-${randomUUID()}@example.test`;
    const { data, error } = await anonClient().auth.signUp({ email, password: TEST_PASSWORD });
    expect(error).toBeNull();
    expect(data.session).toBeNull();
    const attempt = await anonClient().auth.signInWithPassword({ email, password: TEST_PASSWORD });
    expect(attempt.data.session).toBeNull();
    expect(attempt.error?.message).toMatch(/confirm/i);
    if (data.user) await adminClient().auth.admin.deleteUser(data.user.id);
  });

  it("anonymous sign-ins are disabled", async () => {
    const { data, error } = await anonClient().auth.signInAnonymously();
    expect(data.session).toBeNull();
    expect(error).not.toBeNull();
  });

  it("only an Auth-server-confirmed address for the same user passes the account check", () => {
    const id = randomUUID();
    expect(isEmailConfirmed({ id, email_confirmed_at: "2026-01-01T00:00:00Z" }, id)).toBe(true);
    expect(isEmailConfirmed({ id, email_confirmed_at: null }, id)).toBe(false);
    expect(isEmailConfirmed({ id, email_confirmed_at: "2026-01-01T00:00:00Z" }, randomUUID())).toBe(false);
    expect(isEmailConfirmed(null, id)).toBe(false);
  });
});
