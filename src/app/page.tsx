import { SignedInHome } from "@/components/app/signed-in-home";
import { SignedOutHome } from "@/components/marketing/signed-out-home";
import { getRequestUser } from "@/lib/server/auth/require-user";

export default async function HomePage() {
  const user = await getRequestUser();
  return user ? <SignedInHome /> : <SignedOutHome />;
}
