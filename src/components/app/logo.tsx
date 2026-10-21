import { cn } from "cn";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[9px]", className)}>
      <span
        aria-hidden="true"
        className="flex h-[30px] w-[26px] shrink-0 flex-col gap-1 rounded-[3px] bg-primary pt-2 pl-1.5"
      >
        <span className="h-[1.5px] w-3.5 bg-white" />
        <span className="h-[1.5px] w-3.5 bg-white" />
        <span className="h-[1.5px] w-[9px] bg-white" />
      </span>
      <span className="font-heading text-2xl font-semibold text-foreground">NotePrep</span>
    </span>
  );
}
