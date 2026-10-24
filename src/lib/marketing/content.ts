/** Typed copy for the signed-out landing page. No prices, no alignment or accuracy claims (see tests). */

export interface Benefit {
  title: string;
  body: string;
}
export interface Step {
  title: string;
  body: string;
  /** Short caption under the step, as in the design. */
  tag: string;
}
export interface DocumentCard {
  id: "notes" | "worksheet" | "solutions";
  name: string;
  body: string;
  /** The compiled sample PDF, page 1 as a PNG, and its intrinsic size (see scripts/build-marketing-samples.ts). */
  pdf: string;
  image: string;
  alt: string;
  width: number;
  height: number;
}
export interface FaqItem {
  question: string;
  answer: string;
}

const SAMPLE_IMAGE = { width: 900, height: 1165 } as const;

export const landingContent = {
  nav: [
    { label: "Features", href: "#features" },
    { label: "How it works", href: "#how-it-works" },
    { label: "Pricing", href: "#pricing" },
  ],
  hero: {
    eyebrow: "For private math tutors · LaTeX-quality PDFs",
    title: "Better teaching materials. Less prep time.",
    subtitle:
      "Choose a topic, a lesson length and a difficulty, and NotePrep builds tutor lesson notes, a student worksheet and a separate answer key as typeset PDFs. You review the AI-assisted material before teaching.",
    primaryCta: "Get started",
    note: "3 free lesson packs. No credit card needed.",
  },
  builder: {
    overline: "Real output · compiled by NotePrep",
    overlineNote: "A tutor-facing document builder with a selection form, a free draft preview and PDF export.",
    title: "Tutor workspace / Document builder",
    badge: "Sample preview",
    panelTitle: "Create a lesson pack",
    panelBody: "Select the curriculum, level, course and topic, then the lesson length and difficulty. The material is AI-assisted: review it before teaching.",
    fields: [
      { label: "Curriculum", value: "Sample Mathematics (not a real curriculum)" },
      { label: "Level", value: "Sample Level A" },
      { label: "Course", value: "Sample Course 1" },
      { label: "Topic", value: "Unknown on both sides" },
      { label: "Lesson length", value: "60 minutes" },
      { label: "Difficulty", value: "Mixed (easy to hard)" },
    ],
    checkbox: "Include Solutions / Answer Key",
    generate: "Create draft preview",
    openPdf: "Open the sample PDF",
    caption:
      "These previews are the first pages of real PDFs compiled by NotePrep from sample data. The sample is not a real curriculum and makes no alignment claim.",
  },
  benefits: {
    eyebrow: "Built for private tutors",
    title: "Professional teaching materials with less preparation.",
    items: [
      {
        title: "Start from a selection, not a blank page.",
        body: "Pick the topic, the lesson length and the difficulty. The structure, worked examples and exercises are drafted for you.",
      },
      {
        title: "Questions and answers that match.",
        body: "Questions and answers come from deterministic solvers and are checked in code, so the answer key matches the worksheet.",
      },
      {
        title: "Professional printable documents.",
        body: "LaTeX-quality typesetting, consistent layout and print-ready PDFs. Each document looks like a polished teaching resource.",
      },
    ] satisfies Benefit[],
  },
  how: {
    eyebrow: "The tutor workflow",
    title: "Select → Preview → Adjust → Export.",
  },
  steps: [
    { title: "Select", body: "Pick the curriculum, level, course and topic, then the lesson length and difficulty.", tag: "Your teaching context" },
    { title: "Preview", body: "Get a free draft you can read and adjust. Drafts use no generation.", tag: "Notes, worksheet and answer key" },
    { title: "Adjust", body: "Replace or remove a question and make another version of the draft.", tag: "Free until you export" },
    { title: "Export", body: "Export uses 1 generation only when all of your PDFs are ready. Then download them as separate PDFs.", tag: "PDF · Print or share your way" },
  ] satisfies Step[],
  documents: [
    {
      id: "notes",
      name: "Tutor Lesson Notes",
      body: "Objectives, timing, explanations, worked examples and common mistakes for you to teach from.",
      pdf: "/samples/notes.pdf",
      image: "/samples/notes-1.png",
      alt: "First page of the sample Tutor Lesson Notes PDF: title, learning objectives, prerequisites and key ideas for a sample topic.",
      ...SAMPLE_IMAGE,
    },
    {
      id: "worksheet",
      name: "Student Practice Worksheet",
      body: "Exercises with space to write. It never includes the answers.",
      pdf: "/samples/worksheet.pdf",
      image: "/samples/worksheet-1.png",
      alt: "First page of the sample Student Practice Worksheet PDF: three equations to solve, each with ruled writing space.",
      ...SAMPLE_IMAGE,
    },
    {
      id: "solutions",
      name: "Solutions / Answer Key",
      body: "Step-by-step solutions in their own document, so you decide when students see them.",
      pdf: "/samples/solutions.pdf",
      image: "/samples/solutions-1.png",
      alt: "First page of the sample Solutions and Answer Key PDF: each equation solved step by step with the final answer.",
      ...SAMPLE_IMAGE,
    },
  ] satisfies DocumentCard[],
  showcase: {
    eyebrow: "Real results",
    title: "Typeset materials for every tutoring session.",
    packChip: "01 / Three documents",
    packTitle: "One lesson, three printable documents.",
    packBody: "Request all three or just the ones you need. The answer key is always a separate document.",
    packPoints: ["A lesson plan for you to teach from", "A worksheet students can write on", "Step-by-step solutions kept apart"],
    packPanelLabel: "PDF preview",
    packPanelCaption: "Tutor notes · sample output",
    reviewChip: "02 / You stay in charge",
    reviewTitle: "Typeset to read well. Reviewed by you.",
    reviewBody:
      "Please review AI-assisted material before teaching. Read the draft preview before you export, and read the PDFs before you teach. The math is produced and checked by code rather than written by the AI.",
    reviewPoints: ["Preview before you export", "Three separate documents, with answers kept apart", "A review reminder on every lesson"],
    callout: "Print-ready PDFs with LaTeX quality",
    calloutBody: "Consistent layouts, typeset equations and a separate tutor copy of the solutions.",
    answerPanelLabel: "Worked solutions",
    footnote: "Your expertise stays in the loop: review every document before teaching.",
  },
  pricing: {
    eyebrow: "Plans",
    title: "Start free, subscribe later",
    subtitle: "Try the whole workflow before you decide anything.",
    free: {
      title: "Free",
      label: "Available now",
      points: ["3 complete lesson packs, for the lifetime of your account", "No credit card required", "Full preview and PDF export"],
      cta: "Get started",
    },
    subscription: {
      title: "Monthly subscription",
      label: "Monthly plan",
      points: ["A monthly allowance of lesson packs", "For tutors who prepare lessons regularly"],
      note: "Subscriptions are not available yet.",
      cardNote: "Not available yet",
    },
  },
  faq: {
    eyebrow: "Tutor FAQs",
    title: "A little clarity before you begin.",
    subtitle: "Clear answers about creating and exporting your materials.",
    items: [
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
  },
  finalCta: {
    eyebrow: "For private tutors · LaTeX-quality PDFs",
    title: "Bring your teaching expertise. Leave the typesetting to NotePrep.",
    body: "Start with a topic. Leave with three printable PDFs for your lesson, ready for your review.",
    cta: "Get started",
  },
  footer: {
    tagline: "Lesson prep for private math tutors.",
    copyright: "© NotePrep. All rights reserved.",
  },
};
