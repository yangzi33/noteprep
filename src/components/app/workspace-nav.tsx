"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Files, FileText, SquarePen } from "lucide-react";
import { cn } from "cn";
import { activeNavHref, NAV_ITEMS, type NavIcon } from "@/lib/ui/nav";

const ICONS: Record<NavIcon, typeof SquarePen> = {
  create: SquarePen,
  materials: Files,
  legacy: FileText,
};

export function WorkspaceNav() {
  const pathname = usePathname();
  const active = activeNavHref(
    pathname,
    NAV_ITEMS.map((i) => i.href),
  );
  return (
    <nav aria-label="Main" className="overflow-x-auto md:overflow-visible">
      <ul className="flex gap-1 p-2 md:flex-col md:p-4">
        {NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.icon];
          const isActive = item.href === active;
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-control px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-secondary",
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
