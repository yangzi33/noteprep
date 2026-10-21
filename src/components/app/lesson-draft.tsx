import { Inlines, MathView } from "@/components/app/math";
import type { HtmlBlock, HtmlDocument } from "@/lib/package/html-view";

type Alignment = Extract<HtmlBlock, { type: "alignment" }>;

// Wording mirrors alignmentTex in src/lib/latex/render.ts so the draft says what the PDF says.
// Compact (worksheet and solutions) is the one-line form; notes keep the full form.
function AlignmentText({ block, compact }: { block: Alignment; compact: boolean }) {
  const name = `${block.curriculumName} (${block.versionLabel})`;
  if (block.claim === "aligned") {
    if (compact) return <p>{`Curriculum: ${name}.`}</p>;
    return (
      <>
        <p>This lesson addresses objectives from {name}:</p>
        <ul className="list-disc pl-6">
          {block.objectives.map((o, i) => (
            <li key={i}>
              {o.officialCode ? `${o.officialCode}: ` : ""}
              {o.label}
              {o.partial ? <em> (partly covered{o.note ? `: ${o.note}` : ""})</em> : null}
            </li>
          ))}
        </ul>
      </>
    );
  }
  if (compact) return <p>No curriculum alignment is claimed.</p>;
  const origin = block.datasetKind === "real" ? "" : ` It was prepared from ${block.datasetKind === "sample" ? "sample" : "test"} data (${name}) that is not a real curriculum.`;
  return <p>{`No curriculum alignment is claimed for this material.${origin}`}</p>;
}

function Steps({ steps }: { steps: Extract<HtmlBlock, { type: "worked" }>["steps"] }) {
  return (
    <ol className="list-decimal space-y-1 pl-6">
      {steps.map((s, i) => (
        <li key={i}>
          <Inlines parts={s.parts} />:
          <div className="overflow-x-auto">
            <MathView tex={s.resultTex} mode="display" />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Block({ block, compact }: { block: HtmlBlock; compact: boolean }) {
  switch (block.type) {
    case "paragraph":
      return <p>{block.text}</p>;
    case "note":
      return <p className="italic">{block.text}</p>;
    case "list":
      return (
        <ul className="list-disc space-y-1 pl-6">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="list-decimal space-y-1 pl-6">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    case "timing":
      return (
        <ul className="list-disc space-y-1 pl-6">
          {block.items.map((item, i) => (
            <li key={i}>
              {item.label} … {item.minutes} min
            </li>
          ))}
        </ul>
      );
    case "writing_space":
      return (
        <div aria-hidden="true" className="space-y-6 py-2">
          {Array.from({ length: lineCount(block.lines) }, (_, i) => (
            <div key={i} className="border-b border-border" />
          ))}
        </div>
      );
    case "question":
      return (
        <p>
          <strong>{block.number}.</strong> Solve for <MathView tex="x" mode="inline" />:
          <span className="block overflow-x-auto">
            <MathView tex={block.tex} mode="display" />
          </span>
        </p>
      );
    case "worked":
    case "solution":
      return (
        <div className="space-y-2">
          <p>
            <strong>{block.type === "worked" ? `Example ${block.number}.` : `${block.number}.`}</strong>{" "}
            {block.type === "worked" ? "Solve for " : null}
            {block.type === "worked" ? <MathView tex="x" mode="inline" /> : null}
            {block.type === "worked" ? ":" : null}
          </p>
          <div className="overflow-x-auto">
            <MathView tex={block.problemTex} mode="display" />
          </div>
          <Steps steps={block.steps} />
          <p className="font-medium">
            <strong>Answer:</strong>{" "}
            <Inlines parts={block.answer} />
          </p>
        </div>
      );
    case "alignment":
      return <AlignmentText block={block} compact={compact} />;
  }
}

// Bounded like the PDF renderer: 1 to 20 lines.
const lineCount = (lines: number) => (Number.isFinite(lines) ? Math.min(Math.max(Math.trunc(lines), 1), 20) : 1);

export function LessonDraft({ doc }: { doc: HtmlDocument }) {
  return (
    <article
      data-testid="lesson-draft"
      data-document={doc.document}
      className="mx-auto w-full max-w-[794px] space-y-6 rounded-notice border border-border bg-white p-4 sm:p-8 text-[15px] leading-relaxed text-neutral-900 shadow-sm"
    >
      <header className="space-y-1 text-center">
        <p className="font-heading text-2xl font-semibold">{doc.title}</p>
        <p className="text-lg">{doc.subtitle}</p>
        {doc.meta ? <p className="text-sm text-neutral-600">{doc.meta}</p> : null}
      </header>
      {doc.sections.map((section) => (
        <section key={section.id} className="space-y-3">
          {section.kind === "alignment" ? null : <h2 className="font-heading text-lg font-semibold">{section.title}</h2>}
          {section.blocks.map((block, i) => (
            <Block key={i} block={block} compact={doc.document !== "notes"} />
          ))}
        </section>
      ))}
    </article>
  );
}
