import type { DocumentKind } from "@/lib/package/schema";
import { escapeText, RenderError } from "./escape";

/**
 * The only preamble that ever reaches the compiler. It lives in version control; neither model output nor user input
 * can add a package, change a path, or define a macro. Bump the version when the output for a given package changes.
 * classic/2: the running header's left field is the selected topic's title (classic/1 printed a fixed "NotePrep").
 */
export const TEMPLATE_VERSION = "classic/2";

/** Page formats of an export (an export option, not draft content). Letter is the default and its source never changes. */
export const PAGE_FORMATS = ["letter", "a4"] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];
const PAPER_OPTION: Record<PageFormat, string> = { letter: "letterpaper", a4: "a4paper" };

export const DOCUMENT_TITLES: Record<DocumentKind, string> = {
  notes: "Tutor Lesson Notes",
  worksheet: "Student Practice Worksheet",
  solutions: "Solutions / Answer Key",
};

/**
 * Control sequences the BODY of a document may contain: exactly what the renderer emits, and nothing from the preamble
 * (so a body cannot load a package, redefine a macro or change a page setting). Anything else is a defect.
 */
export const ALLOWED_BODY_COMMANDS: ReadonlySet<string> = new Set([
  "begin", "end", "section", "par", "item", "textbf", "textit", "large", "Large", "medskip", "smallskip", "hfill", "quad", "qquad",
  "rule", "linewidth", "displaystyle", "frac", "writeline", "answerline",
  // escapes produced by escapeText
  "textbackslash", "textasciitilde", "textasciicircum", "textless", "textgreater", "textbar", "textquotedbl", "ldots",
]);

/** Control symbols (a backslash and one non-letter) that may appear. */
export const ALLOWED_CONTROL_SYMBOLS: ReadonlySet<string> = new Set(["\\", "{", "}", "$", "&", "#", "_", "%", "[", "]", ";", ","]);

/** Longest running title, in characters, ellipsis included. */
export const MAX_RUNNING_TITLE = 60;
/** Used when the topic title is empty (the same for all three documents of a package). */
export const DEFAULT_RUNNING_TITLE = "NotePrep";

/**
 * The left header field as safe LaTeX. Dataset text: normalized, cut to MAX_RUNNING_TITLE characters (57 + "...", counted in
 * code points) BEFORE escaping, then passed through escapeText like every other text. escapeText keeps ordinary spaces
 * (it maps only U+00A0 to "~", and whitespace collapsing removes that first), so the parbox in the header can wrap.
 */
export function runningTitleTex(topicTitle: string): string {
  const chars = Array.from(topicTitle.normalize("NFC").replace(/\s+/g, " ").trim());
  if (chars.length === 0) return escapeText(DEFAULT_RUNNING_TITLE);
  const cut = chars.length > MAX_RUNNING_TITLE ? `${chars.slice(0, MAX_RUNNING_TITLE - 3).join("").trimEnd()}...` : chars.join("");
  return escapeText(cut);
}

export function preamble(document: DocumentKind, runningTitle: string, pageFormat: PageFormat = "letter"): string {
  // Second guard behind the callers' allowlists: an inherited key such as "constructor" must never reach the document class line.
  if (!Object.hasOwn(PAPER_OPTION, pageFormat)) throw new RenderError("invalid_page_format");
  return [
    // Object compression off: every PDF dictionary stays readable text, so the host can scan for active content (an
    // object stream would hide dictionaries inside compressed bytes) and reject any PDF that has one.
    "\\pdfobjcompresslevel=0",
    `\\documentclass[11pt,${PAPER_OPTION[pageFormat]}]{article}`,
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage{lmodern}",
    "\\usepackage{amsmath}",
    "\\usepackage[margin=2.2cm,headheight=28pt]{geometry}",
    "\\usepackage{fancyhdr}",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{0.6em}",
    "\\pagestyle{fancy}",
    "\\fancyhf{}",
    // The title is escaped text in a parbox: it wraps at its spaces instead of running into the right field. headheight
    // leaves room for two lines; a single unbroken run of ~35+ wide capitals can still overflow sideways (cosmetic only).
    `\\fancyhead[L]{\\parbox[b]{0.6\\textwidth}{\\raggedright ${runningTitleTex(runningTitle)}}}`,
    `\\fancyhead[R]{${DOCUMENT_TITLES[document].replace("/", "\\textbar{}")}}`,
    "\\fancyfoot[C]{\\thepage}",
    "\\renewcommand{\\headrulewidth}{0.3pt}",
    "\\renewcommand{\\footrulewidth}{0pt}",
    "\\newcommand{\\writeline}{\\par\\vspace{0.9cm}\\noindent\\rule{\\linewidth}{0.2pt}}",
    // Only the documents that show answers define the macro, so a worksheet's source never contains the word.
    ...(document === "worksheet" ? [] : ["\\newcommand{\\answerline}[1]{\\par\\noindent\\textbf{Answer:} #1}"]),
    "",
  ].join("\n");
}
