import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignedOutHome } from "@/components/marketing/signed-out-home";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { homeTarget } from "@/lib/ui/home-target";

export const metadata: Metadata = { title: { absolute: "NotePrep: lesson prep for math tutors" } };

export default async function HomePage() {
  const target = homeTarget(await getRequestUser());
  if (target !== "landing") redirect(target);
  return <SignedOutHome />;
}
