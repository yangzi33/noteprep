import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getRequestUser } from "@/lib/server/auth/require-user";

export default async function HomePage() {
  const user = await getRequestUser();
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">noteprep</h1>
      <p className="mt-2">Lesson preparation for independent math tutors.</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Phase 1 skeleton: the generation pipeline runs end to end, but the lessons are placeholders, not real handouts.
      </p>
      <div className="mt-6">
        {user ? (
          <Button asChild>
            <Link href="/prepare">Prepare a lesson</Link>
          </Button>
        ) : (
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        )}
      </div>
    </main>
  );
}
