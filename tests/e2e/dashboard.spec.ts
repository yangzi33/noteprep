import { expect, test } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

test("the dashboard greets a new account, shows the allowance and links to Create material", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A little less prep. More teaching.");
  await expect(page.getByTestId("allowance")).toHaveText("3 of 3 generations left.");
  await expect(page.getByRole("link", { name: "Create material" }).first()).toHaveAttribute("href", "/prepare");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
