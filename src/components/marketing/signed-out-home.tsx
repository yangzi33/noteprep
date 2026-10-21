import { PublicHeader } from "@/components/app/public-header";
import { LandingFooter, LandingPage } from "./landing-page";

export function SignedOutHome() {
  return (
    <>
      <PublicHeader variant="landing" />
      <main>
        <LandingPage />
      </main>
      <LandingFooter />
    </>
  );
}
