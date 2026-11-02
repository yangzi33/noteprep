export interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
}

type Env = Record<string, string | undefined>;

/** Marks a deploy that serves real testers. Such a deploy refuses to build with an unconfirmed notice (see tester-deploy.ts). */
export const TESTER_DEPLOY_VAR = "NOTEPREP_TESTER_DEPLOY";
/** The name of the party that actually sends sign-in and password emails. Owner-confirmed; never guessed in code. */
export const MAIL_SENDER_VAR = "NOTEPREP_MAIL_SENDER";

/** True when a value is empty or still a template placeholder such as "<mail sender>" or "TBD". */
export function isPlaceholder(raw: string | undefined | null): boolean {
  const v = raw?.trim() ?? "";
  return v === "" || /[<>]/.test(v) || /^(tbd|todo|changeme|to be confirmed|owner[- ]to[- ]confirm)\b/i.test(v);
}

export function mailSender(env: Env): string | null {
  const v = env[MAIL_SENDER_VAR]?.trim() ?? "";
  return isPlaceholder(v) || v.length > 80 ? null : v;
}

const FIXED: readonly Subprocessor[] = [
  { name: "Vercel", purpose: "Hosts the NotePrep website.", data: "Requests to the site, including your IP address, and the pages we send back." },
  { name: "Supabase", purpose: "Sign-in, the database and private file storage.", data: "Your email address, your lesson requests, drafts and lesson packs, and your exported PDFs." },
  { name: "DigitalOcean", purpose: "Runs the server that builds your PDFs.", data: "The lesson content of an export while it is being built. The PDF builder has no network access and keeps nothing." },
];

const AI_DATA = "Concept names, learning objectives, difficulty, lesson length and an approximate grade band. Never your email, account details or any student information.";

/** AI providers a worker can be configured with. Add an entry here in the same change that adds an adapter. */
const AI_PROVIDERS: Readonly<Record<string, Subprocessor>> = {
  anthropic: { name: "Anthropic", purpose: "Writes some lesson wording and practice questions with AI.", data: AI_DATA },
};

export interface PrivacyDisclosure {
  subprocessors: readonly Subprocessor[];
  /** One sentence on AI use, derived from LLM_PROVIDER. */
  aiStatement: string;
}

/**
 * Builds the subprocessor list and the AI sentence from configuration. Anything other than the "fake" provider counts as
 * AI switched on, and an unknown provider is disclosed generically instead of being passed over.
 */
export function buildDisclosure(env: Env): PrivacyDisclosure {
  const sender: Subprocessor = {
    name: mailSender(env) ?? "Sign-in email sender (not yet confirmed)",
    purpose: "Sends the sign-in and password emails.",
    data: "Your email address and the text of those emails.",
  };
  const provider = (env.LLM_PROVIDER?.trim() || "fake").toLowerCase();
  if (provider === "fake") {
    return { subprocessors: [...FIXED, sender], aiStatement: "AI writing is switched off in this test: no lesson data is sent to any AI provider." };
  }
  const ai = AI_PROVIDERS[provider] ?? { name: "An AI provider", purpose: "Writes some lesson wording and practice questions with AI.", data: AI_DATA };
  return { subprocessors: [...FIXED, sender, ai], aiStatement: `AI writing is switched on: lesson context is sent to ${ai.name}.` };
}

export const TEST_NOTICE = "NotePrep is a private test version. Things may change or break.";
export const ANONYMOUS_NOTICE = "Use fictional or anonymous examples. Do not enter real student names or other personal details about students, here or in the feedback you send us.";
export const REVIEW_NOTICE = "Lesson materials can contain mistakes. Read everything before you use it with a student.";
