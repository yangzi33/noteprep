"use client";

import * as React from "react";
import { cn } from "cn";
import { filterTimeZones } from "@/lib/ui/timezone";

type TimeZonePickerProps = {
  label: string;
  name: string;
  zones: readonly string[];
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
};

/** Searchable time zone dropdown styled like TextField/SelectField. The input itself is submitted, so the server still validates the text. */
export function TimeZonePicker({ label, name, zones, defaultValue = "", placeholder, hint }: TimeZonePickerProps) {
  const id = React.useId();
  const listId = `${id}-list`;
  const hintId = hint ? `${id}-hint` : undefined;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const [open, setOpen] = React.useState(false);
  // Filter only after the tutor types; opening with a chosen zone shows the full list so they can browse.
  const [query, setQuery] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(-1);
  const [current, setCurrent] = React.useState(defaultValue);

  const options = React.useMemo(() => (query === null ? [...zones] : filterTimeZones(query, zones)), [query, zones]);
  const optionId = (i: number) => `${id}-opt-${i}`;

  React.useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${optionId(active)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived from id, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const choose = (zone: string) => {
    if (inputRef.current) inputRef.current.value = zone;
    setCurrent(zone);
    setQuery(null);
    setActive(-1);
    setOpen(false);
  };

  const openList = () => {
    if (open) return;
    setActive(current ? zones.indexOf(current) : -1);
    setOpen(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (options.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a < 0 ? (step === 1 ? 0 : options.length - 1) : (a + step + options.length) % options.length));
    } else if (e.key === "Enter" && open && active >= 0 && options[active]) {
      e.preventDefault();
      choose(options[active]!);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Home" && open && options.length > 0) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open && options.length > 0) {
      e.preventDefault();
      setActive(options.length - 1);
    }
  };

  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative" onBlur={onBlur}>
        <input
          ref={inputRef}
          id={id}
          name={name}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          aria-describedby={hintId}
          autoComplete="off"
          required
          maxLength={100}
          defaultValue={defaultValue}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onClick={openList}
          onKeyDown={onKeyDown}
          className="min-h-11 w-full rounded-control border border-input bg-card py-0 pr-10 pl-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Hide time zones" : "Show time zones"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else {
              inputRef.current?.focus();
              openList();
            }
          }}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground"
        >
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className={cn("transition-transform", open && "rotate-180")}>
            <path d="M2 4.25 6 8l4-3.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-control border border-border bg-card py-1 text-sm text-foreground shadow-[0_8px_32px_rgb(32_44_41/0.12)]"
          >
            {options.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-muted-foreground">
                No matching time zone
              </li>
            ) : (
              options.map((zone, i) => (
                <li
                  key={zone}
                  id={optionId(i)}
                  role="option"
                  aria-selected={zone === current}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => active !== i && setActive(i)}
                  onClick={() => choose(zone)}
                  className={cn("min-h-9 cursor-pointer px-3 py-2", i === active && "bg-accent text-accent-foreground", zone === current && "font-medium")}
                >
                  {zone}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {hint ? (
        <p id={hintId} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
