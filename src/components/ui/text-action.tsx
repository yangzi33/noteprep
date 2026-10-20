import * as React from "react";
import Link from "next/link";
import { cn } from "cn";

type CommonProps = { icon?: React.ReactNode };

type TextActionProps =
  | (CommonProps & { href: string } & Omit<React.ComponentProps<typeof Link>, "href">)
  | (CommonProps & { href?: undefined } & React.ComponentProps<"button">);

const base =
  "inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TextAction(props: TextActionProps) {
  if (props.href !== undefined) {
    const { href, icon, className, children, ...rest } = props;
    return (
      <Link href={href} className={cn(base, className)} {...rest}>
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        {children}
      </Link>
    );
  }
  const { icon, className, children, type = "button", ...rest } = props;
  return (
    <button type={type} className={cn(base, className)} {...rest}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}
