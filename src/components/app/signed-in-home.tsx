import Link from "next/link";
import { Button } from "@/components/ui/button";

export function SignedInHome() {
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
