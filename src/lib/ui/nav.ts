export type NavIcon = "dashboard" | "create" | "materials" | "account";

export const NAV_ITEMS: readonly { href: string; label: string; icon: NavIcon }[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/prepare", label: "Create lesson pack", icon: "create" },
  { href: "/lessons", label: "My lesson packs", icon: "materials" },
  { href: "/account", label: "Account", icon: "account" },
];

/** Returns the longest href matching pathname on a path segment boundary, or null. */
export function activeNavHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (pathname === href || pathname.startsWith(`${href}/`)) {
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}
