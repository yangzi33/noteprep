import { z } from "zod";

/** The shape of a client-supplied idempotency key (shared by generation and drafts). */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
