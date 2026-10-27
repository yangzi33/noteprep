import type { Metadata } from "next";
import { ContactLink } from "@/components/app/contact-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { accountNotice } from "@/lib/ui/login-messages";
import { allowanceSentence, dailyRefreshReminder } from "@/lib/ui/dashboard-view";
import { supportEmail } from "@/lib/supabase/public-env";
import { signOut } from "../login/actions";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const noticeText = accountNotice(notice);
  const { email, ctx } = await requireAccount();
  const allowance = await webDal().history.getAllowance(ctx);
  const reminder = dailyRefreshReminder(allowance);
  const support = supportEmail();
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-4 py-8 md:px-8">
      <h1 className="select-none font-heading text-2xl font-semibold text-foreground">Account</h1>
      {noticeText && (
        <Notice intent="success" className="mt-4">
          {noticeText}
        </Notice>
      )}
      <Card className="mt-6 p-6">
        <p className="text-sm text-foreground">Signed in as {email}.</p>
        <form className="mt-4">
          <Button type="submit" variant="outline" formAction={signOut}>
            Sign out
          </Button>
        </form>
      </Card>
      <Card className="mt-4 flex flex-col gap-2 p-6">
        <h2 className="select-none font-heading text-lg">Your allowance</h2>
        <p className="text-sm" data-testid="allowance">
          {reminder ? <span data-testid="refresh-reminder">{reminder}</span> : allowanceSentence(allowance)}
        </p>
        <p className="text-sm text-muted-foreground">A lesson pack is used only when you export your PDFs. Drafts and edits are free.</p>
        <p className="text-sm text-muted-foreground">Subscriptions are not available yet.</p>
      </Card>
      <Card className="mt-4 flex flex-col gap-2 p-6">
        <h2 className="select-none font-heading text-lg">Help and your files</h2>
        <p className="text-sm">
          {support ? (
            <>
              Questions or feedback? Email <ContactLink email={support} />.
            </>
          ) : (
            <>
              Questions or feedback? <ContactLink words="Contact us" email={null} />.
            </>
          )}
        </p>
        <p className="text-sm text-muted-foreground">Your exported lesson packs stay available to download from My lesson packs until you delete them.</p>
      </Card>
    </main>
  );
}
