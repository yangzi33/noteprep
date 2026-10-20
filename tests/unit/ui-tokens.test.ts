import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");

function block(startPattern: RegExp): string {
  const m = startPattern.exec(css);
  if (!m) throw new Error(`block not found: ${startPattern}`);
  let depth = 0;
  for (let i = css.indexOf("{", m.index); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(m.index, i + 1);
  }
  throw new Error("unbalanced block");
}

const root = block(/^:root\s*\{/m);
const theme = block(/@theme inline\s*\{/);

const rootTokens: Record<string, string> = {
  background: "#f8f7f3",
  foreground: "#202c29",
  card: "#ffffff",
  "card-foreground": "#202c29",
  popover: "#ffffff",
  "popover-foreground": "#202c29",
  primary: "#245f50",
  "primary-foreground": "#ffffff",
  secondary: "#f0f1ec",
  "secondary-foreground": "#202c29",
  muted: "#f0f1ec",
  "muted-foreground": "#626d67",
  accent: "#e9f0eb",
  "accent-foreground": "#245f50",
  destructive: "#a53c34",
  border: "#d9ded7",
  input: "#7d8c83",
  ring: "#245f50",
  sidebar: "#f8f7f3",
  "sidebar-foreground": "#202c29",
  "sidebar-primary": "#245f50",
  "sidebar-primary-foreground": "#ffffff",
  "sidebar-accent": "#e9f0eb",
  "sidebar-accent-foreground": "#245f50",
  "sidebar-border": "#d9ded7",
  "sidebar-ring": "#245f50",
  surface: "#ffffff",
  "surface-inverse": "#202c29",
  "danger-surface": "#fbf0ed",
  "border-danger": "#a53c34",
  "text-accent": "#245f50",
  "text-disabled": "#57635c",
  "on-dark-muted": "#dce4dd",
  "primary-hover": "#194839",
  "action-disabled": "#e2e5df",
};

describe("design tokens", () => {
  it.each(Object.entries(rootTokens))(":root --%s", (name, value) => {
    expect(root.toLowerCase()).toContain(`--${name}: ${value};`);
  });

  it.each([
    "surface",
    "surface-inverse",
    "danger-surface",
    "border-danger",
    "text-accent",
    "text-disabled",
    "on-dark-muted",
    "primary-hover",
    "action-disabled",
  ])("@theme maps --color-%s", (name) => {
    expect(theme).toContain(`--color-${name}: var(--${name});`);
  });

  it.each([
    ["tag", "4px"],
    ["control", "6px"],
    ["notice", "8px"],
    ["card", "12px"],
  ])("@theme radius-%s", (name, px) => {
    expect(theme).toContain(`--radius-${name}: ${px};`);
  });

  it("maps font families to the next/font variables", () => {
    expect(theme).toContain(
      "--font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;",
    );
    expect(theme).toContain(
      "--font-heading: var(--font-lora), ui-serif, Georgia, serif;",
    );
  });

  it("keeps the .dark block and drops the body font override", () => {
    expect(css).toMatch(/^\.dark\s*\{/m);
    expect(css).not.toMatch(/^body\s*\{\s*font-family/m);
  });
});
