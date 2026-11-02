export interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  { name: "Vercel", purpose: "Hosts the NotePrep website.", data: "Requests to the site, including your IP address, and the pages we send back." },
  { name: "Supabase", purpose: "Sign-in, the database and private file storage.", data: "Your email address, your lesson requests, drafts and lesson packs, and your exported PDFs." },
  { name: "DigitalOcean", purpose: "Runs the server that builds your PDFs.", data: "The lesson content of an export while it is being built. The PDF builder has no network access and keeps nothing." },
  { name: "Resend", purpose: "Sends the sign-in and password emails.", data: "Your email address and the text of those emails." },
  {
    name: "OpenAI",
    purpose: "Planned: writing some practice questions with AI. Switched off in this test: nothing is sent to OpenAI.",
    data: "If it is switched on later: concept names, learning objectives, difficulty, lesson length and an approximate grade band. Never your email, account details or any student information.",
  },
];

export const TEST_NOTICE = "NotePrep is a private test version. Things may change or break.";
export const ANONYMOUS_NOTICE = "Use fictional or anonymous examples. Do not enter real student names or other personal details about students, here or in the feedback you send us.";
export const REVIEW_NOTICE = "Lesson materials can contain mistakes. Read everything before you use it with a student.";
