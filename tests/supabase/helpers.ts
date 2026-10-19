import { createHmac, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inject } from "vitest";

export function env() {
  return inject("supabase");
}

/** Stateless clients: no session persistence, so tests never leak sessions into each other. */
export function anonClient(): SupabaseClient {
  const e = env();
  return createClient(e.apiUrl, e.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function adminClient(): SupabaseClient {
  const e = env();
  return createClient(e.apiUrl, e.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const TEST_PASSWORD = "correct horse battery staple";

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

const created: string[] = [];

export async function createConfirmedUser(): Promise<TestUser> {
  const email = `user-${randomUUID()}@example.test`;
  const { data, error } = await adminClient().auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  created.push(data.user.id);
  const { data: session, error: signInError } = await anonClient().auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signInError || !session.session) throw signInError ?? new Error("sign-in failed");
  return { id: data.user.id, email, accessToken: session.session.access_token };
}

export async function deleteCreatedUsers() {
  const admin = adminClient();
  await Promise.all(created.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** Builds a JWT the way an attacker holding a (public, local-demo) shared secret would. */
export function forgeHs256(secret: string, payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64url(sig)}`;
}

export function decodePayload(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
}
