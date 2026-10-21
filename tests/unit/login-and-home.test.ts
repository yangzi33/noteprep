import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginForm } from "@/components/app/login-form";
import { SignedOutHome } from "@/components/marketing/signed-out-home";
import { homeTarget } from "@/lib/ui/home-target";
import { loginMessage } from "@/lib/ui/login-messages";

const noop = async () => {};

describe("loginMessage", () => {
  it("returns messages for known keys", () => {
    expect(loginMessage("invalid")).toMatch(/at least 10 characters/);
    expect(loginMessage("unverified")).toMatch(/confirm your email/);
    expect(loginMessage("callback")).toMatch(/invalid or expired/);
    expect(loginMessage("check-email")).toMatch(/confirmation email/);
  });
  it("ignores undefined, unknown and inherited keys", () => {
    for (const key of [undefined, "", "unknown", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(loginMessage(key), String(key)).toBeUndefined();
    }
  });
});

describe("LoginForm", () => {
  const html = renderToStaticMarkup(createElement(LoginForm, { signIn: noop, signUp: noop }));
  const input = (name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

  it("ties the Email and Password labels to their inputs by id", () => {
    for (const [label, name] of [["Email", "email"], ["Password", "password"]] as const) {
      const id = input(name).match(/id="([^"]+)"/)?.[1];
      expect(id, name).toBeTruthy();
      expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${label}</label>`));
    }
  });

  it("keeps the input attributes", () => {
    const email = input("email");
    expect(email).toContain('type="email"');
    expect(email).toContain("required");
    expect(email).toContain('autoComplete="email"');
    const password = input("password");
    expect(password).toContain('type="password"');
    expect(password).toContain("required");
    expect(password).toContain('minLength="10"');
    expect(password).toContain('maxLength="72"');
    expect(password).toContain('autoComplete="current-password"');
  });

  it("has two real submit buttons named Sign in and Create account", () => {
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)];
    expect(buttons.map((b) => b[2])).toEqual(["Sign in", "Create account"]);
    for (const b of buttons) expect(b[1]).toContain('type="submit"');
  });
});

describe("home page branches", () => {
  it("signed-out home has one h1, one main, a footer outside main and a Get started link", () => {
    const html = renderToStaticMarkup(createElement(SignedOutHome));
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<main[ >]/g)).toHaveLength(1);
    expect(html.match(/<footer[ >]/g)).toHaveLength(1);
    expect(html.indexOf("</main>")).toBeLessThan(html.indexOf("<footer"));
    expect(html).toMatch(/href="\/login"[^>]*>Get started/);
  });
  it("sends signed-in visitors to the dashboard and everyone else to the landing page", () => {
    expect(homeTarget({ id: "u1" })).toBe("/dashboard");
    expect(homeTarget(null)).toBe("landing");
    expect(homeTarget(undefined)).toBe("landing");
  });
});
