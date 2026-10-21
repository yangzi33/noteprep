"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Download } from "lucide-react";
import type { DocumentCard } from "@/lib/marketing/content";

/**
 * The tabbed paper in the hero: three REAL compiled sample documents (page 1 as a PNG, and the PDF to open). Only the
 * active tab is a state; the server renders the default tab, so the worksheet is visible without JavaScript.
 */
export function SamplePreview({ documents, defaultId, openLabel }: { documents: DocumentCard[]; defaultId: DocumentCard["id"]; openLabel: string }) {
  const [active, setActive] = useState<DocumentCard["id"]>(defaultId);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = documents.find((d) => d.id === active) ?? documents[0]!;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const home = event.key === "Home" ? 0 : event.key === "End" ? documents.length - 1 : null;
    if (!step && home === null) return;
    event.preventDefault();
    const next = home ?? (index + step + documents.length) % documents.length;
    setActive(documents[next]!.id);
    tabs.current[next]?.focus();
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div role="tablist" aria-label="Sample documents" className="-mx-2 flex flex-wrap gap-x-1">
          {documents.map((d, i) => (
            <button
              key={d.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`sample-tab-${d.id}`}
              aria-selected={d.id === active}
              aria-controls={`sample-panel-${d.id}`}
              tabIndex={d.id === active ? 0 : -1}
              onClick={() => setActive(d.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`min-h-11 rounded-control px-2 text-xs font-medium focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none md:px-3 md:text-[13px] ${
                d.id === active ? "text-text-accent underline decoration-2 underline-offset-8" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {d.name}
            </button>
          ))}
        </div>
        <a
          href={current.pdf}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-control text-[13px] font-medium text-text-accent underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Download aria-hidden="true" className="size-4" />
          {openLabel}
          <span className="sr-only">{`: ${current.name} (PDF, opens in a new tab)`}</span>
        </a>
      </div>
      {documents.map((d) => (
        <div
          key={d.id}
          role="tabpanel"
          id={`sample-panel-${d.id}`}
          aria-labelledby={`sample-tab-${d.id}`}
          hidden={d.id !== active}
          className="mx-auto w-full max-w-[560px] border border-border bg-card shadow-[0_1px_2px_rgb(32_44_41/0.06)]"
        >
          {/* A pre-rendered PNG of page 1 of a compiled PDF with its intrinsic size: next/image would only re-encode it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={d.image}
            alt={d.alt}
            width={d.width}
            height={d.height}
            loading={d.id === defaultId ? "eager" : "lazy"}
            decoding="async"
            className="block h-auto w-full"
          />
        </div>
      ))}
    </div>
  );
}
