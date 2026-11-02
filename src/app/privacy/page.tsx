import type { Metadata } from "next";
import { LegalPage } from "@/components/app/legal-page";
import { PrivacyContent } from "@/components/app/legal-content";

export const metadata: Metadata = { title: "Privacy (test version)" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice (test version)">
      <PrivacyContent />
    </LegalPage>
  );
}
