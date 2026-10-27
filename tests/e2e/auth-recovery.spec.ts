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

test("an invalid recovery code lands on the login page with the fixed message and no echo", async ({ page }) => {
  await page.goto("/auth/recovery?code=not-a-real-code&next=https://evil.example");
  await expect(page).toHaveURL(/\/login\?error=recovery$/);
  await expect(page.locator("main [role=alert]")).toContainText("invalid or expired");
});

test("the new-password page sends a signed-out visitor to sign in", async ({ page }) => {
  await page.goto("/account/password");
  await expect(page).toHaveURL(/\/login$/);
});
