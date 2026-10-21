import { redirect } from "next/navigation";
import { SignedOutHome } from "@/components/marketing/signed-out-home";
import { getRequestUser } from "@/lib/server/auth/require-user";
import { homeTarget } from "@/lib/ui/home-target";

export default async function HomePage() {
  const target = homeTarget(await getRequestUser());
  if (target !== "landing") redirect(target);
  return <SignedOutHome />;
}
