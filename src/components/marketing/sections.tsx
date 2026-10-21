import Link from "next/link";
import { ArrowRight, BookOpen, BookOpenCheck, Check, ChevronDown, Clock, FileText, Info, Minus, Plus, Printer } from "lucide-react";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";
import { landingContent as c } from "@/lib/marketing/content";
import { SamplePreview } from "./sample-preview";

const wrap = "mx-auto w-full max-w-[1440px] px-4 md:px-10 lg:px-24";
const sectionPad = "py-14 md:py-20 lg:py-24";
const overline = "text-[11px] font-semibold tracking-[0.12em] text-text-accent uppercase";
const h2 = "font-heading text-[28px] leading-[1.2] font-normal text-foreground md:text-4xl lg:text-[40px]";
const body = "text-[15px] leading-6 text-muted-foreground md:text-base md:leading-[26px]";

function SectionHead({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className={overline}>{eyebrow}</p>
      <h2 id={id} className={h2}>
        {title}
      </h2>
    </div>
  );
}

function FieldLookalike({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="flex min-h-10 items-center justify-between gap-2 rounded-control border border-input bg-card px-3 text-[13px] text-foreground">
        <span className="min-w-0 py-2 leading-snug">{value}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </span>
    </div>
  );
}

export function HeroSection() {
  const { hero, builder, documents } = c;
  return (
    <section aria-labelledby="hero-title" className="pt-14 pb-14 md:pt-20 md:pb-20 lg:pt-[78px]">
      <div className={`${wrap} flex flex-col items-center gap-5 text-center`}>
        <p className={overline}>{hero.eyebrow}</p>
        <h1
          id="hero-title"
          className="max-w-[900px] font-heading text-[40px] leading-[1.1] font-normal text-balance text-foreground md:text-6xl lg:text-[64px] lg:leading-[72px]"
        >
          {hero.title.split(/(?<=\.) /).map((sentence, i) => (
            <span key={sentence} className="block">
              {i > 0 ? " " : ""}
              {sentence}
            </span>
          ))}
        </h1>
        <p className="max-w-[680px] text-base leading-7 text-pretty text-muted-foreground md:text-xl md:leading-[30px]">{hero.subtitle}</p>
        <Button asChild className="mt-2 px-6">
          <Link href="/login">
            {hero.primaryCta}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        <p className="-mt-1 text-[13px] text-muted-foreground">{hero.note}</p>
      </div>

      <div className={`${wrap} mt-14 md:mt-[52px]`}>
        <div className="mb-4 flex flex-col justify-between gap-1 md:flex-row md:items-baseline md:gap-8">
          <p className={overline}>{builder.overline}</p>
          <p className="text-[13px] text-muted-foreground md:text-right">{builder.overlineNote}</p>
        </div>
        <div className="overflow-hidden rounded-card border border-border bg-card shadow-[0_8px_32px_rgb(32_44_41/0.06)]">
          <div className="flex min-h-14 items-center justify-between gap-3 border-b px-4 py-2 md:min-h-16 md:px-6">
            <p className="flex items-center gap-3 text-[13px] font-medium text-foreground">
              <BookOpen aria-hidden="true" className="size-5 shrink-0 text-text-accent" />
              {builder.title}
            </p>
            <span className="rounded-tag bg-accent px-2.5 py-1 text-xs font-medium whitespace-nowrap text-text-accent">{builder.badge}</span>
          </div>
          <div className="flex flex-col lg:flex-row">
            <div aria-hidden="true" className="order-2 flex flex-col gap-4 border-t bg-card p-5 lg:order-1 lg:w-[294px] lg:shrink-0 lg:border-t-0 lg:border-r lg:p-6">
              <p className="text-lg font-semibold text-foreground">{builder.panelTitle}</p>
              <p className="text-sm leading-[23px] text-muted-foreground">{builder.panelBody}</p>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-1 lg:gap-3.5">
                {builder.fields.map((f, i) => (
                  <FieldLookalike key={f.label} label={f.label} value={f.value} className={i === 0 ? "col-span-2 lg:col-span-1" : ""} />
                ))}
              </div>
              <div className="flex items-center gap-2 text-[13px] text-foreground">
                <span className="flex size-4 items-center justify-center rounded-tag bg-primary text-primary-foreground">
                  <Check className="size-3" strokeWidth={3} />
                </span>
                {builder.checkbox}
              </div>
              <span className="flex min-h-12 items-center justify-center rounded-control bg-primary text-sm font-semibold text-primary-foreground">
                {builder.generate}
              </span>
            </div>
            <div className="order-1 min-w-0 flex-1 bg-secondary lg:order-2">
              <SamplePreview documents={documents} defaultId="worksheet" openLabel={builder.openPdf} />
            </div>
          </div>
        </div>
        <p className="mx-auto mt-5 max-w-[760px] text-center text-xs leading-5 text-muted-foreground">{builder.caption}</p>
      </div>
    </section>
  );
}

const benefitIcons = [Clock, BookOpenCheck, FileText];

export function BenefitsSection() {
  const { benefits } = c;
  return (
    <section id="features" aria-labelledby="benefits-title" className="scroll-mt-20 bg-card">
      <div className={`${wrap} ${sectionPad} flex flex-col gap-10 md:gap-12`}>
        <SectionHead id="benefits-title" eyebrow={benefits.eyebrow} title={benefits.title} />
        <ul className="grid gap-10 md:grid-cols-3 md:gap-12">
          {benefits.items.map((b, i) => {
            const Icon = benefitIcons[i] ?? Check;
            return (
              <li key={b.title} className="flex flex-col gap-4">
                <Icon aria-hidden="true" className="size-6 text-text-accent" strokeWidth={1.5} />
                <h3 className="font-heading text-[22px] leading-[30px] font-normal text-foreground">{b.title}</h3>
                <p className="text-[15px] leading-[26px] text-muted-foreground">{b.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function HowItWorksSection() {
  const { how, steps } = c;
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-20">
      <div className={`${wrap} ${sectionPad} flex flex-col gap-10 md:gap-12`}>
        <SectionHead id="how-title" eyebrow={how.eyebrow} title={how.title} />
        <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-10">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-4">
              <span aria-hidden="true" className="border-b pb-3 font-heading text-[32px] leading-10 text-text-accent">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="text-lg font-semibold text-foreground">
                <span className="sr-only">{`Step ${i + 1}: `}</span>
                {s.title}
              </h3>
              <p className="text-[15px] leading-[26px] text-muted-foreground">{s.body}</p>
              <p className="text-xs text-text-accent">{s.tag}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function PaperImage({ doc, className = "" }: { doc: (typeof c.documents)[number]; className?: string }) {
  return (
    <div className={`border border-border bg-card ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={doc.image} alt={doc.alt} width={doc.width} height={doc.height} loading="lazy" decoding="async" className="block h-auto w-full" />
    </div>
  );
}

export function ShowcaseSection() {
  const { showcase } = c;
  const [notes, , solutions] = c.documents;
  return (
    <section aria-labelledby="showcase-title" className="bg-card">
      <div className={`${wrap} ${sectionPad} flex flex-col gap-12 md:gap-16`}>
        <SectionHead id="showcase-title" eyebrow={showcase.eyebrow} title={showcase.title} />

        <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-16">
          <div className="flex flex-col items-start gap-5">
            <span className="rounded-tag bg-accent px-2.5 py-1 text-xs font-medium text-text-accent">{showcase.packChip}</span>
            <h3 className="font-heading text-[28px] leading-9 font-normal text-foreground md:text-[32px] md:leading-10">{showcase.packTitle}</h3>
            <p className={body}>{showcase.packBody}</p>
            <ul className="flex flex-col gap-3">
              {showcase.packPoints.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-sm text-foreground">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-accent" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
          {notes && (
            <div className="flex flex-col gap-4 rounded-card bg-secondary p-4 md:p-6">
              <p className="text-xs font-medium text-text-accent">{showcase.packPanelLabel}</p>
              <PaperImage doc={notes} className="mx-auto w-full max-w-[520px]" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold tracking-[0.1em] text-text-accent uppercase">{showcase.packPanelCaption}</p>
                <a
                  href={notes.pdf}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex min-h-11 items-center text-[13px] font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {c.builder.openPdf}
                  <span className="sr-only">{`: ${notes.name} (PDF, opens in a new tab)`}</span>
                </a>
              </div>
            </div>
          )}
        </div>

        <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-16">
          {solutions && (
            <div className="order-2 flex flex-col gap-4 rounded-card bg-accent p-4 md:p-6 lg:order-1">
              <p className="text-xs font-medium text-text-accent">{showcase.answerPanelLabel}</p>
              <PaperImage doc={solutions} className="mx-auto w-full max-w-[520px]" />
              <div className="flex justify-end">
                <a
                  href={solutions.pdf}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex min-h-11 items-center text-[13px] font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {c.builder.openPdf}
                  <span className="sr-only">{`: ${solutions.name} (PDF, opens in a new tab)`}</span>
                </a>
              </div>
            </div>
          )}
          <div className="order-1 flex flex-col items-start gap-5 lg:order-2">
            <span className="rounded-tag bg-accent px-2.5 py-1 text-xs font-medium text-text-accent">{showcase.reviewChip}</span>
            <h3 className="font-heading text-[28px] leading-9 font-normal text-foreground md:text-[32px] md:leading-10">{showcase.reviewTitle}</h3>
            <p className={body}>{showcase.reviewBody}</p>
            <ul className="flex flex-col gap-3">
              {showcase.reviewPoints.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-sm text-foreground">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-accent" />
                  {p}
                </li>
              ))}
            </ul>
            <div className="flex w-full items-start gap-3 rounded-notice bg-background p-4">
              <Printer aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-accent" />
              <div>
                <p className="text-[13px] font-semibold text-foreground">{showcase.callout}</p>
                <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{showcase.calloutBody}</p>
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{showcase.footnote}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PricingSection() {
  const { pricing } = c;
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20">
      <div className={`${wrap} ${sectionPad} flex flex-col gap-8 md:gap-10`}>
        <div className="flex flex-col gap-4">
          <SectionHead id="pricing-title" eyebrow={pricing.eyebrow} title={pricing.title} />
          <p className={`${body} max-w-[720px]`}>{pricing.subtitle}</p>
        </div>
        <div className="flex items-center gap-3 rounded-notice bg-accent px-4 py-3.5 text-sm text-text-accent">
          <Info aria-hidden="true" className="size-4 shrink-0" />
          {pricing.subscription.note}
        </div>
        <div className="grid gap-5 md:grid-cols-2 md:gap-6">
          <div className="flex flex-col gap-5 rounded-card border border-border bg-card p-6 md:p-8">
            <p className="text-[11px] tracking-[0.08em] text-text-accent uppercase">{pricing.free.label}</p>
            <h3 className="font-heading text-[28px] leading-9 font-normal text-foreground">{pricing.free.title}</h3>
            <ul className="flex flex-col gap-3">
              {pricing.free.points.map((p) => (
                <li key={p} className="flex items-start gap-3 text-[15px] text-foreground">
                  <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-text-accent" />
                  {p}
                </li>
              ))}
            </ul>
            <Button asChild variant="outline" className="mt-auto w-full">
              <Link href="/login">
                {pricing.free.cta}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
          <div className="flex flex-col gap-5 rounded-card border-2 border-primary bg-card p-6 md:p-8">
            <p className="text-[11px] tracking-[0.08em] text-text-accent uppercase">{pricing.subscription.label}</p>
            <h3 className="font-heading text-[28px] leading-9 font-normal text-foreground">{pricing.subscription.title}</h3>
            <ul className="flex flex-col gap-3">
              {pricing.subscription.points.map((p) => (
                <li key={p} className="flex items-start gap-3 text-[15px] text-foreground">
                  <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-text-accent" />
                  {p}
                </li>
              ))}
            </ul>
            <p className="mt-auto rounded-control bg-secondary px-4 py-3.5 text-center text-sm font-medium text-muted-foreground">{pricing.subscription.cardNote}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function FaqSection() {
  const { faq } = c;
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 bg-card">
      <div className={`${wrap} ${sectionPad} grid gap-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-24`}>
        <div className="flex flex-col gap-4">
          <SectionHead id="faq-title" eyebrow={faq.eyebrow} title={faq.title} />
          <p className={`${body} max-w-[360px]`}>{faq.subtitle}</p>
        </div>
        <div className="border-t">
          {faq.items.map((item, i) => (
            <details key={item.question} open={i === 0} className="group border-b">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 text-[15px] font-semibold text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                {item.question}
                <Plus aria-hidden="true" className="size-4 shrink-0 text-text-accent group-open:hidden" />
                <Minus aria-hidden="true" className="hidden size-4 shrink-0 text-text-accent group-open:block" />
              </summary>
              <p className="pb-5 text-[15px] leading-[26px] text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCtaSection() {
  const { finalCta } = c;
  return (
    <section aria-labelledby="cta-title" className="bg-accent">
      <div className={`${wrap} flex flex-col items-center gap-5 py-14 text-center md:py-20 lg:py-[84px]`}>
        <p className={overline}>{finalCta.eyebrow}</p>
        <h2 id="cta-title" className="max-w-[660px] font-heading text-[30px] leading-[1.2] font-normal text-balance text-foreground md:text-4xl lg:text-[44px] lg:leading-[55px]">
          {finalCta.title}
        </h2>
        <p className="max-w-[600px] text-base leading-7 text-muted-foreground md:text-[17px]">{finalCta.body}</p>
        <Button asChild className="mt-2 px-6">
          <Link href="/login">
            {finalCta.cta}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}

export function LandingFooter() {
  const link = "inline-flex min-h-11 items-center rounded-control px-2 text-sm text-foreground hover:text-text-accent focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";
  return (
    <footer className="bg-background">
      <div className={`${wrap} flex flex-col gap-8 py-10 md:py-12`}>
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-start">
          <div className="flex max-w-[420px] flex-col gap-3">
            <Logo />
            <p className="text-sm leading-[21px] text-muted-foreground">{c.footer.tagline}</p>
          </div>
          <nav aria-label="Footer" className="-mx-2 flex flex-wrap items-center md:mx-0">
            {c.nav.map((item) => (
              <a key={item.href} href={item.href} className={link}>
                {item.label}
              </a>
            ))}
            <Link href="/login" className={link}>
              Login
            </Link>
          </nav>
        </div>
        <p className="border-t pt-6 text-[13px] text-muted-foreground">{c.footer.copyright}</p>
      </div>
    </footer>
  );
}
