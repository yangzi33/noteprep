import type { ReactNode } from "react";
import { PublicHeader } from "@/components/app/public-header";
import { getRequestUser } from "@/lib/server/auth/require-user";

export async function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const user = await getRequestUser();
  return (
    <>
      {!user && <PublicHeader />}
      <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-4 py-8 md:px-8">
        <h1 className="font-heading text-2xl font-semibold text-foreground">{title}</h1>
        <div className="mt-4 flex flex-col gap-3 text-sm leading-6 text-foreground [&_h2]:mt-4 [&_h2]:font-heading [&_h2]:text-lg [&_h2]:font-semibold [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5">{children}</div>
      </main>
    </>
  );
}
