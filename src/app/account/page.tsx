import type { Metadata } from "next";
import { ContactLink } from "@/components/app/contact-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { TextField } from "@/components/ui/text-field";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { accountError, accountNotice } from "@/lib/ui/login-messages";
import { getTimeZoneInfo } from "@/lib/server/timezone";
import { supportedTimeZones } from "@/lib/ui/timezone";
import { allowanceSentence, dailyRefreshReminder } from "@/lib/ui/dashboard-view";
import { supportEmail } from "@/lib/supabase/public-env";
import { signOut } from "../login/actions";
import { resetTimeZone, saveTimeZone } from "./timezone-actions";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const noticeText = accountNotice(notice);
  const errorText = accountError(error);
  const { email, ctx } = await requireAccount();
  const allowance = await webDal().history.getAllowance(ctx);
  const reminder = dailyRefreshReminder(allowance);
  const tz = await getTimeZoneInfo(ctx);
  const support = supportEmail();
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-4 py-8 md:px-8">
      <h1 className="select-none font-heading text-2xl font-semibold text-foreground">Account</h1>
      {noticeText && (
        <Notice intent="success" className="mt-4">
          {noticeText}
        </Notice>
      )}
      {errorText && (
        <Notice intent="error" className="mt-4">
          {errorText}
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
      <Card className="mt-4 flex flex-col gap-3 p-6" data-testid="timezone-card">
        <h2 className="select-none font-heading text-lg">Time zone</h2>
        <p className="text-sm" data-testid="timezone-current">
          Times are shown in {tz.effective} {tz.saved ? "(your setting)" : "(detected from your browser)"}.
        </p>
        <form action={saveTimeZone} className="flex flex-col gap-3">
          <TextField label="Time zone" name="timezone" list="timezone-options" defaultValue={tz.saved ?? ""} placeholder="Start typing, for example Toronto" autoComplete="off" required maxLength={100} hint="Search by city or region. Stored times stay in UTC; only how they are shown changes." />
          <datalist id="timezone-options">
            {supportedTimeZones().map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-3">
            <Button type="submit">Save time zone</Button>
            <Button type="submit" variant="outline" formAction={resetTimeZone} formNoValidate>
              Auto (detect)
            </Button>
          </div>
        </form>
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
