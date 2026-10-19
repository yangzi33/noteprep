import { z } from "zod";

// Browser-safe configuration only: the Supabase URL and the publishable key. Next.js inlines
// NEXT_PUBLIC_* variables only when they are written out literally, hence the explicit reads.
const PublicEnv = z.object({
  url: z.url(),
  publishableKey: z.string().min(1),
  siteUrl: z.url(),
});

export function publicEnv() {
  return PublicEnv.parse({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  });
}
