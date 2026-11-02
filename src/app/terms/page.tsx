import type { Metadata } from "next";
import { LegalPage } from "@/components/app/legal-page";
import { TermsContent } from "@/components/app/legal-content";

export const metadata: Metadata = { title: "Terms (test version)" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of the test (test version)">
      <TermsContent />
    </LegalPage>
  );
}
