import { supportEmail } from "@/lib/supabase/public-env";
import { splitAtContact } from "@/lib/ui/support";

const linkClass = "underline rounded-control focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

/** The address as a mailto link, or the plain words "contact us" (plus an optional fallback) when no address is configured. */
export function ContactLink({ words = "contact us", email = supportEmail(), fallback }: { words?: string; email?: string | null; fallback?: string }) {
  return email ? (
    <a href={`mailto:${email}`} className={linkClass}>
      {email}
    </a>
  ) : (
    <>
      {words}
      {fallback ? ` ${fallback}` : null}
    </>
  );
}

/** Renders a pure message; when an address exists, "contact us" is followed by "at <address>" as a mailto link. */
export function ContactText({ text, email = supportEmail() }: { text: string; email?: string | null }) {
  const parts = email ? splitAtContact(text) : null;
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      {parts.phrase} at <ContactLink email={email} />
      {parts.after}
    </>
  );
}
