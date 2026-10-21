import Link from "next/link";
import { PublicHeader } from "@/components/app/public-header";
import { LandingPage } from "@/components/marketing/landing-page";
import { Button } from "@/components/ui/button";
import { getRequestUser } from "@/lib/server/auth/require-user";

export default async function HomePage() {
  const user = await getRequestUser();
  if (!user) {
    return (
      <>
        <PublicHeader />
        <main>
          <LandingPage />
        </main>
      </>
    );
  }
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="font-heading text-2xl font-semibold">NotePrep</h1>
      <p className="mt-2">Lesson preparation for independent math tutors.</p>
      <div className="mt-6">
        <Button asChild>
          <Link href="/prepare">Prepare a lesson</Link>
        </Button>
      </div>
    </main>
  );
}
