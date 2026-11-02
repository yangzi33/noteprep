import { ContactLink } from "@/components/app/contact-link";
import { ANONYMOUS_NOTICE, REVIEW_NOTICE, SUBPROCESSORS } from "@/lib/ui/legal";

export function PrivacyContent() {
  return (
    <>
      <p>
        This is a plain-language notice for a private test of NotePrep. It is not a legal policy and has not been reviewed by a lawyer. Questions, access and deletion requests: <ContactLink words="contact us" />.
      </p>
      <h2>What we store</h2>
      <ul>
        <li>Your email address and the account created for it.</li>
        <li>Your lesson requests (topic, level, lesson length, difficulty), your drafts and lesson packs, and the PDFs you export.</li>
        <li>Usage records: when drafts and exports were made, their status, error types and your remaining allowance. They contain no lesson text.</li>
        <li>A hashed form of your IP address, kept for a limited time to limit abuse.</li>
        <li>Any feedback you email to us.</li>
      </ul>
      <p>We use only the cookies needed to keep you signed in. We run no analytics and no advertising.</p>
      <h2>What we ask you not to enter</h2>
      <p>{ANONYMOUS_NOTICE}</p>
      <h2>Who handles your data</h2>
      <p>These services process data for us. Where a provider keeps data, and for how long, follows that provider&apos;s own terms. We do not promise zero retention or that data is not used for training beyond what a provider states.</p>
      <ul>
        {SUBPROCESSORS.map((s) => (
          <li key={s.name}>
            <strong>{s.name}.</strong> {s.purpose} {s.data}
          </li>
        ))}
      </ul>
      <p>We have not fixed a data region for this test, and providers may process data outside your country. Ask us if you need to know where your data is stored.</p>
      <h2>How long we keep it</h2>
      <ul>
        <li>Drafts expire after 14 days without use.</li>
        <li>Lesson packs and exported PDFs stay until they are deleted. We plan to delete all test accounts and their data after the test round ends.</li>
        <li>Backups at our providers can lag behind a deletion.</li>
      </ul>
      <h2>Your choices</h2>
      <p>
        You can ask us at any time to delete your account and everything stored with it. Deletion is manual during the test: <ContactLink words="contact us" />.
      </p>
    </>
  );
}

export function TermsContent() {
  return (
    <>
      <p>These plain-language terms cover the private test of NotePrep. They are not legal advice and have not been reviewed by a lawyer.</p>
      <h2>A test, by invitation</h2>
      <ul>
        <li>NotePrep is an early test version for invited tutors. It can change, break or be switched off at any time, and your account and data may be removed when the test ends.</li>
        <li>It is free during the test. Nothing is charged and no payment details are collected.</li>
        <li>Only the equation topics shown in the app work so far.</li>
      </ul>
      <h2>Review before you teach</h2>
      <p>{REVIEW_NOTICE} The service is provided as is, without any promise that it is correct, complete or always available.</p>
      <h2>Your part</h2>
      <ul>
        <li>{ANONYMOUS_NOTICE}</li>
        <li>Use your own account and keep your sign-in details private.</li>
        <li>Do not try to break, overload or probe the service.</li>
      </ul>
      <h2>Your materials</h2>
      <p>You may use the PDFs you export for your own tutoring. Curriculum names, where shown, are an unofficial guide and are not endorsed by any curriculum authority.</p>
      <h2>Feedback</h2>
      <p>
        We welcome it: <ContactLink words="contact us" />. We may use your feedback to improve NotePrep.
      </p>
    </>
  );
}
