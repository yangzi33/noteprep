import Link from "next/link";
import { supportEmail } from "@/lib/supabase/public-env";
import { TEST_NOTICE } from "@/lib/ui/legal";

const link = "underline underline-offset-2 rounded-control focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

export function TestBanner() {
  const support = supportEmail();
  return (
    <div role="note" data-testid="test-banner" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-border bg-accent px-4 py-2 text-center text-[13px] leading-5 text-text-accent">
      <span>{TEST_NOTICE}</span>
      <span className="flex flex-wrap items-center justify-center gap-x-3">
        {support ? (
          <a href={`mailto:${support}?subject=NotePrep%20feedback`} className={`${link} select-text`}>
            Send feedback
          </a>
        ) : null}
        <Link href="/privacy" className={link}>
          Privacy
        </Link>
        <Link href="/terms" className={link}>
          Terms
        </Link>
      </span>
    </div>
  );
}
