"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Files, LayoutDashboard, SquarePen, UserRound } from "lucide-react";
import { cn } from "cn";
import { activeNavHref, NAV_ITEMS, type NavIcon } from "@/lib/ui/nav";

const ICONS: Record<NavIcon, typeof SquarePen> = {
  dashboard: LayoutDashboard,
  create: SquarePen,
  materials: Files,
  account: UserRound,
};

export function WorkspaceNav() {
  const pathname = usePathname();
  const active = activeNavHref(
    pathname,
    NAV_ITEMS.map((i) => i.href),
  );
  return (
    <nav aria-label="Main">
      <ul className="grid grid-cols-4 gap-1 p-2 md:flex md:flex-col md:p-4">
        {NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.icon];
          const isActive = item.href === active;
          return (
            <li key={item.href} className="min-w-0 md:shrink-0">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-11 flex-col items-center justify-center gap-1 rounded-control px-1 text-center text-xs leading-tight font-medium outline-none md:flex-row md:justify-start md:gap-2 md:px-3 md:text-left md:text-sm md:whitespace-nowrap focus-visible:ring-3 focus-visible:ring-ring",
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
