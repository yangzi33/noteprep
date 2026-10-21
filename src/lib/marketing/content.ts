/** Typed copy for the signed-out landing page. No prices, no alignment or accuracy claims (see tests). */

export interface Benefit {
  title: string;
  body: string;
}
export interface Step {
  title: string;
  body: string;
}
export interface DocumentCard {
  name: string;
  body: string;
  /** Short static lines drawn inside the mock card. */
  lines: string[];
}
export interface FaqItem {
  question: string;
  answer: string;
}

export const landingContent = {
  hero: {
    eyebrow: "For independent math tutors",
    title: "Prepare a complete math lesson pack without starting from a blank page",
    subtitle:
      "Choose the course and topic, pick a lesson length and difficulty, and NotePrep builds lesson notes, a student worksheet and a separate answer key as PDFs.",
    primaryCta: "Get started",
    secondaryCta: "See how it works",
    note: "3 free lesson packs. No credit card needed.",
  },
  benefits: [
    {
      title: "Less preparation time",
      body: "Start from a selection, not a blank page. The structure, examples and exercises are drafted for you.",
    },
    {
      title: "Worked and checked math",
      body: "Questions and answers come from deterministic solvers and are checked in code, so the answer key matches the worksheet.",
    },
    {
      title: "Print-ready PDFs",
      body: "Documents use LaTeX-quality typesetting and export as PDFs that are ready to print or share.",
    },
  ] satisfies Benefit[],
  steps: [
    { title: "Select", body: "Pick the curriculum, level, course and topic, then the lesson length and difficulty." },
    { title: "Generate", body: "Start the job. You can leave the page and come back; progress is kept." },
    { title: "Preview", body: "Read the draft preview and open the PDF before you decide to export." },
    { title: "Export PDF", body: "Download the notes, worksheet and answer key as separate PDFs." },
  ] satisfies Step[],
  documents: [
    {
      name: "Tutor Lesson Notes",
      body: "Objectives, timing, explanations, worked examples and common mistakes for you to teach from.",
      lines: ["Learning objectives", "Suggested timing", "Worked example", "Common mistakes"],
    },
    {
      name: "Student Practice Worksheet",
      body: "Exercises at different difficulty levels with space to write. It never includes the answers.",
      lines: ["1. Practice question", "2. Practice question", "3. Challenge question"],
    },
    {
      name: "Solutions / Answer Key",
      body: "Step-by-step solutions in their own document, so you decide when students see them.",
      lines: ["1. Steps and answer", "2. Steps and answer", "3. Steps and answer"],
    },
  ] satisfies DocumentCard[],
  showcase: {
    packTitle: "Three documents, one lesson",
    packBody: "Request all three or just the ones you need. The answer key is always a separate document.",
    reviewTitle: "You stay in charge",
    reviewBody:
      "Please review AI-assisted material before teaching. Read the draft preview and the generated PDF before you export. The math is produced and checked by code rather than written by the AI.",
    reviewPoints: ["Preview before you export", "Three separate documents, with answers kept apart", "A review reminder on every lesson"],
  },
  pricing: {
    title: "Start free, subscribe later",
    subtitle: "Try the whole workflow before you decide anything.",
    free: {
      title: "Free",
      points: ["3 complete lesson packs, for the lifetime of your account", "No credit card required", "Full preview and PDF export"],
    },
    subscription: {
      title: "Monthly subscription",
      points: ["A monthly allowance of lesson packs", "For tutors who prepare lessons regularly"],
      note: "Subscriptions are not available yet.",
    },
  },
  faq: [
    {
      question: "Do I need to know LaTeX?",
      answer: "No. LaTeX is used behind the scenes for typesetting. You choose options and preview the result; you never write or edit LaTeX.",
    },
    {
      question: "Is the material ready to teach as is?",
      answer: "It is AI-assisted. Review it before teaching.",
    },
    {
      question: "Does the worksheet include the answers?",
      answer: "No. Answers and step-by-step solutions are in the separate Solutions / Answer Key document.",
    },
    {
      question: "What happens after the 3 free packs?",
      answer: "Your earlier lessons stay available to view and download. Subscriptions are not available yet.",
    },
    {
      question: "What should I put in my account?",
      answer: "You need an email address and a password to create an account. Please do not enter student names or other personal details.",
    },
  ] satisfies FaqItem[],
  finalCta: {
    title: "Ready for your next lesson?",
    body: "Create an account and generate your first pack.",
    cta: "Get started",
  },
  footer: {
    copyright: "© NotePrep. All rights reserved.",
  },
};
