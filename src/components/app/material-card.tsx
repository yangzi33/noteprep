import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { DraftCardModel, MaterialCardModel } from "@/lib/ui/dashboard-view";

/** Dashboard tile: state, title, date and exactly one link. */
export function MaterialCard({ card }: { card: MaterialCardModel }) {
  return (
    <Card className="flex h-full flex-col gap-3 p-5" data-state={card.state}>
      <Badge tone={card.state === "succeeded" ? "accent" : "neutral"} className="self-start">
        {card.label}
      </Badge>
      <h3 className="font-heading text-lg leading-snug break-words">{card.title}</h3>
      <p className="text-sm text-muted-foreground">{card.date}</p>
      <Link
        href={card.href}
        aria-label={`${card.action}: ${card.title}`}
        className="mt-auto inline-flex min-h-11 items-center text-[13px] font-semibold text-text-accent hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {card.action}
      </Link>
    </Card>
  );
}

/** My materials row: the title is the one link, to the job (or export) status page. */
export function MaterialRow({
  jobId,
  href,
  title,
  state,
  label,
  date,
  outcome,
}: {
  jobId: string;
  /** Defaults to the job page; an export that has not succeeded passes its own status page. */
  href?: string;
  title: string;
  state: string;
  label: string;
  date: string;
  outcome: string | null;
}) {
  return (
    <li data-state={state} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <Link
          href={href ?? `/jobs/${jobId}`}
          className="inline-flex min-h-11 items-center font-heading text-base break-words text-foreground underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {title}
        </Link>
        <p className="text-sm text-muted-foreground">{date}</p>
        {outcome && <p className="mt-1 text-sm text-muted-foreground">{outcome}</p>}
      </div>
      <Badge tone={state === "succeeded" ? "accent" : "neutral"} className="self-start whitespace-nowrap">
        {label}
      </Badge>
    </li>
  );
}

/** Draft tile: title, last update, expiry and exactly one link back to the draft preview. */
export function DraftCard({ card }: { card: DraftCardModel }) {
  return (
    <Card className="flex h-full flex-col gap-3 p-5">
      <Badge tone="neutral" className="self-start">
        Draft
      </Badge>
      <h3 className="font-heading text-lg leading-snug break-words">{card.title}</h3>
      <p className="text-sm text-muted-foreground">
        {card.updated} · <span data-testid="draft-expires">{card.expires}</span>
      </p>
      <Link
        href={card.href}
        aria-label={`Open draft: ${card.title}`}
        className="mt-auto inline-flex min-h-11 items-center text-[13px] font-semibold text-text-accent hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Open draft
      </Link>
    </Card>
  );
}
