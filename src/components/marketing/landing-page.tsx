import {
  BenefitsSection,
  FaqSection,
  FinalCtaSection,
  HeroSection,
  HowItWorksSection,
  LandingFooter,
  PricingSection,
  ShowcaseSection,
} from "./sections";

/** Landing content without the page landmark; the route wraps it in the single <main>. */
export function LandingPage() {
  return (
    <>
      <HeroSection />
      <BenefitsSection />
      <HowItWorksSection />
      <ShowcaseSection />
      <PricingSection />
      <FaqSection />
      <FinalCtaSection />
      <LandingFooter />
    </>
  );
}
