import { z } from "zod";
import { parseSupportEmail } from "@/lib/ui/support";

// Browser-safe configuration only: the Supabase URL and the publishable key. Next.js inlines
// NEXT_PUBLIC_* variables only when they are written out literally, hence the explicit reads.
const PublicEnv = z.object({
  url: z.url(),
  publishableKey: z.string().min(1),
  siteUrl: z.url(),
});

/** The optional public contact address; null when unset or not a plain email. */
export function supportEmail(): string | null {
  return parseSupportEmail(process.env.NEXT_PUBLIC_SUPPORT_EMAIL);
}

export function publicEnv() {
  return PublicEnv.parse({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  });
}
