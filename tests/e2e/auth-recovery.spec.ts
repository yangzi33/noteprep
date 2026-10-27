import { expect, test } from "@playwright/test";

// Everything here works without email delivery: the pages, the validation and the generic responses.
test("the login page links to both recovery pages", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/login/reset");
  await expect(page.getByRole("link", { name: "Didn't get the confirmation email?" })).toHaveAttribute("href", "/login/resend");
  await expect(page.getByText("At least 10 characters")).toBeVisible();
});

for (const [path, heading, button, notice] of [
  ["/login/reset", "Reset your password", "Send reset link", /If this address has an account/],
  ["/login/resend", "Resend the confirmation email", "Resend email", /If this address can be used/],
] as const) {
  test(`${path} renders, rejects a malformed address and answers generically`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Sign in" })).toHaveAttribute("href", "/login");

    // Bypass the browser's own email check so the server-side validation is what answers.
    await page.getByLabel("Email").evaluate((el: HTMLInputElement) => el.form?.setAttribute("novalidate", ""));
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: button }).click();
    await expect(page).toHaveURL(new RegExp(`${path}\\?error=invalid$`));
    await expect(page.locator("main [role=alert]")).toContainText("valid email address");

    await page.getByLabel("Email").fill(`nobody-${Date.now()}@example.test`);
    await page.getByRole("button", { name: button }).click();
    await expect(page).toHaveURL(/\/login\?notice=(reset-sent|check-email)$/);
    await expect(page.locator("main [role=status]")).toContainText(notice);
  });
}

test("opening the recovery page without parameters shows the invalid-link state and echoes nothing", async ({ page }) => {
  await page.goto("/auth/recovery");
  await expect(page.getByRole("heading", { level: 1, name: "This link cannot be used" })).toBeVisible();
  await expect(page.locator("main [role=alert]")).toContainText("invalid or expired");
  await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/login/reset");
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
});

test("a recovery code is only redeemed when Continue is pressed, and a bad one fails with the fixed message", async ({ page }) => {
  await page.goto("/auth/recovery?code=not-a-real-code&next=https://evil.example");
  const origin = new URL(page.url()).origin;
  await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
  await expect(page.getByText("not-a-real-code")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login\?error=recovery$/);
  expect(new URL(page.url()).origin).toBe(origin);
  await expect(page.locator("main [role=alert]")).toContainText("invalid or expired");
});

test("the new-password page sends a signed-out visitor to sign in", async ({ page }) => {
  await page.goto("/account/password");
  await expect(page).toHaveURL(/\/login$/);
});
