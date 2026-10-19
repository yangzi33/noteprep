import type { DocumentKind } from "@/lib/package/schema";

/**
 * The only preamble that ever reaches the compiler. It lives in version control; neither model output nor user input
 * can add a package, change a path, or define a macro. Bump the version when the output for a given package changes.
 */
export const TEMPLATE_VERSION = "classic/1";

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

export function preamble(document: DocumentKind): string {
  return [
    // Object compression off: every PDF dictionary stays readable text, so the host can scan for active content (an
    // object stream would hide dictionaries inside compressed bytes) and reject any PDF that has one.
    "\\pdfobjcompresslevel=0",
    "\\documentclass[11pt,letterpaper]{article}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage{lmodern}",
    "\\usepackage{amsmath}",
    "\\usepackage[margin=2.2cm,headheight=14pt]{geometry}",
    "\\usepackage{fancyhdr}",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{0.6em}",
    "\\pagestyle{fancy}",
    "\\fancyhf{}",
    `\\fancyhead[L]{NotePrep}`,
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
