import Link from "next/link";
import { BookOpen, Check, Clock, FileText, KeyRound, Printer, Sigma } from "lucide-react";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { landingContent as c } from "@/lib/marketing/content";

const wrap = "mx-auto w-full max-w-6xl px-4 md:px-8";
const sectionPad = "py-12 md:py-20";
const h2 = "font-heading text-2xl font-semibold text-foreground md:text-4xl";

function DocMock({ name, lines, icon: Icon }: { name: string; lines: string[]; icon: typeof FileText }) {
  return (
    <Card className="flex flex-col gap-3 p-4" aria-hidden="true">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="size-4 text-text-accent" />
        {name}
      </div>
      <ul className="flex flex-col gap-2 rounded-notice bg-surface p-3 text-[13px] text-muted-foreground">
        {lines.map((line) => (
          <li key={line} className="border-b border-border pb-1.5 last:border-b-0 last:pb-0">
            {line}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function HeroSection() {
  const { hero } = c;
  const [notes, worksheet] = c.documents;
  return (
    <section aria-labelledby="hero-title" className={`${wrap} ${sectionPad} grid items-center gap-10 md:grid-cols-2`}>
      <div className="flex flex-col items-start gap-5">
        <p className="text-sm font-medium text-text-accent">{hero.eyebrow}</p>
        <h1 id="hero-title" className="font-heading text-4xl font-semibold text-foreground md:text-5xl">
          {hero.title}
        </h1>
        <p className="text-base text-muted-foreground md:text-lg">{hero.subtitle}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/login">{hero.primaryCta}</Link>
          </Button>
          <Button asChild variant="outline">
            <a href="#how-it-works">{hero.secondaryCta}</a>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{hero.note}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
        {notes && <DocMock name={notes.name} lines={notes.lines} icon={BookOpen} />}
        {worksheet && <DocMock name={worksheet.name} lines={worksheet.lines} icon={FileText} />}
      </div>
    </section>
  );
}

const benefitIcons = [Clock, Sigma, Printer];

export function BenefitsSection() {
  return (
    <section aria-labelledby="benefits-title" className="border-y bg-card">
      <div className={`${wrap} ${sectionPad}`}>
        <h2 id="benefits-title" className="sr-only">
          Why tutors use NotePrep
        </h2>
        <ul className="grid gap-8 md:grid-cols-3">
          {c.benefits.map((b, i) => {
            const Icon = benefitIcons[i] ?? Check;
            return (
              <li key={b.title} className="flex flex-col gap-2">
                <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-control bg-accent text-text-accent">
                  <Icon className="size-5" />
                </span>
                <h3 className="text-lg font-semibold text-foreground">{b.title}</h3>
                <p className="text-sm text-muted-foreground">{b.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function HowItWorksSection() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className={`${wrap} ${sectionPad} scroll-mt-20`}>
      <h2 id="how-title" className={h2}>
        How it works
      </h2>
      <ol className="mt-8 grid gap-4 md:grid-cols-4">
        {c.steps.map((s, i) => (
          <li key={s.title}>
            <Card className="flex h-full flex-col gap-2 p-5">
              <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <h3 className="text-base font-semibold text-foreground">
                <span className="sr-only">{`Step ${i + 1}: `}</span>
                {s.title}
              </h3>
              <p className="text-sm text-muted-foreground">{s.body}</p>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ShowcaseSection() {
  const { showcase, documents } = c;
  const icons = [BookOpen, FileText, KeyRound];
  return (
    <section aria-labelledby="showcase-title" className="border-y bg-card">
      <div className={`${wrap} ${sectionPad} flex flex-col gap-16`}>
        <h2 id="showcase-title" className="sr-only">
          What you get
        </h2>
        <div className="grid items-center gap-8 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h3 className={h2}>{showcase.packTitle}</h3>
            <p className="text-muted-foreground">{showcase.packBody}</p>
            <ul className="mt-2 flex flex-col gap-3">
              {documents.map((d) => (
                <li key={d.name}>
                  <p className="text-sm font-semibold text-foreground">{d.name}</p>
                  <p className="text-sm text-muted-foreground">{d.body}</p>
                </li>
              ))}
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3" aria-hidden="true">
            {documents.map((d, i) => (
              <DocMock key={d.name} name={d.name} lines={d.lines.slice(0, 3)} icon={icons[i] ?? FileText} />
            ))}
          </div>
        </div>
        <div className="grid items-center gap-8 md:grid-cols-2">
          <Card className="order-2 flex flex-col gap-3 p-5 md:order-1" aria-hidden="true">
            <div className="flex flex-wrap gap-2 text-[13px] font-medium">
              <span className="rounded-control bg-accent px-3 py-1.5 text-text-accent">Easier</span>
              <span className="rounded-control border border-input px-3 py-1.5 text-foreground">Harder</span>
              <span className="rounded-control border border-input px-3 py-1.5 text-foreground">More practice</span>
            </div>
            <div className="rounded-notice bg-surface p-3 text-[13px] text-muted-foreground">Draft preview: check the PDF you export.</div>
          </Card>
          <div className="order-1 flex flex-col gap-3 md:order-2">
            <h3 className={h2}>{showcase.reviewTitle}</h3>
            <p className="text-muted-foreground">{showcase.reviewBody}</p>
            <ul className="flex flex-col gap-2">
              {showcase.reviewPoints.map((p) => (
                <li key={p} className="flex items-start gap-2 text-sm text-foreground">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-accent" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PricingSection() {
  const { pricing } = c;
  const plans: { title: string; points: string[]; note?: string }[] = [pricing.free, pricing.subscription];
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={`${wrap} ${sectionPad} scroll-mt-20`}>
      <h2 id="pricing-title" className={h2}>
        {pricing.title}
      </h2>
      <p className="mt-2 text-muted-foreground">{pricing.subtitle}</p>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {plans.map((plan) => (
          <Card key={plan.title} className="flex flex-col gap-4 p-6">
            <h3 className="text-lg font-semibold text-foreground">{plan.title}</h3>
            <ul className="flex flex-col gap-2">
              {plan.points.map((p) => (
                <li key={p} className="flex items-start gap-2 text-sm text-foreground">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-accent" />
                  {p}
                </li>
              ))}
            </ul>
            {plan.note ? <p className="text-sm font-medium text-muted-foreground">{plan.note}</p> : null}
          </Card>
        ))}
      </div>
    </section>
  );
}

export function FaqSection() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="border-t bg-card">
      <div className={`${wrap} ${sectionPad} max-w-3xl`}>
        <h2 id="faq-title" className={h2}>
          Questions
        </h2>
        <div className="mt-6 divide-y rounded-card border bg-background">
          {c.faq.map((item) => (
            <details key={item.question} className="group px-4 py-1">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                {item.question}
              </summary>
              <p className="pb-3 text-sm text-muted-foreground">{item.answer}</p>
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
    <section aria-labelledby="cta-title" className="bg-surface-inverse">
      <div className={`${wrap} ${sectionPad} flex flex-col items-start gap-4`}>
        <h2 id="cta-title" className="font-heading text-2xl font-semibold text-primary-foreground md:text-4xl">
          {finalCta.title}
        </h2>
        <p className="text-on-dark-muted">{finalCta.body}</p>
        <Button asChild variant="outline">
          <Link href="/login">{finalCta.cta}</Link>
        </Button>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t bg-card">
      <div className={`${wrap} flex flex-col items-start gap-3 py-8 md:flex-row md:items-center md:justify-between`}>
        <Logo />
        <p className="text-sm text-muted-foreground">{c.footer.copyright}</p>
      </div>
    </footer>
  );
}
