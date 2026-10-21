import {
  BenefitsSection,
  FaqSection,
  FinalCtaSection,
  HeroSection,
  HowItWorksSection,
  PricingSection,
  ShowcaseSection,
} from "./sections";

/** Landing content without the page landmarks; the route wraps it in the single <main> and renders LandingFooter after it. */
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
    </>
  );
}

export { LandingFooter } from "./sections";
