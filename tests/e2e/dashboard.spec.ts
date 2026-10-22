import { test, expect } from "@playwright/test";
test("operator journey: create, approve and inspect a browser operation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Open your workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Operations", exact: true }).click();
  const browser = page.locator("article").filter({
    has: page.getByRole("heading", { name: "browser-order", exact: true }),
  });
  await browser.getByRole("button", { name: "Run", exact: true }).click();
  const id = "e2e-" + Date.now();
  await page
    .getByLabel("Input JSON", { exact: true })
    .fill(JSON.stringify({ id, item: "Notebook", quantity: 3 }));
  await page.getByRole("button", { name: "Submit run", exact: true }).click();
  await expect(
    page.getByText("Waiting for an action review", { exact: true }),
  ).toBeVisible();
  const runUrl = page.url();
  await page.getByRole("link", { name: "Review approvals" }).click();
  const approval = page.locator("article").filter({ hasText: id });
  await approval
    .getByRole("button", { name: "Review action", exact: true })
    .click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Reviewed supplier, quantity and order ID");
  await page
    .getByRole("button", { name: "Record decision", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto(runUrl);
  await expect(page.locator(".section-actions .badge")).toHaveText(
    "succeeded",
    { timeout: 45000 },
  );
  await expect(
    page.getByText("Verified output", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "artifacts", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Download", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("lost responses recover and uncertain writes can be reconciled", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  for (const mode of ["lose-response", "unverifiable"]) {
    await page
      .getByRole("button", { name: "New run", exact: true })
      .first()
      .click();
    await page
      .getByLabel("Operation", { exact: true })
      .selectOption("create-order");
    const id = mode + "-" + Date.now();
    await page
      .getByLabel("Input JSON", { exact: true })
      .fill(JSON.stringify({ id, item: "Paper", quantity: 1, mode }));
    await page.getByRole("button", { name: "Submit run", exact: true }).click();
    if (mode === "lose-response")
      await expect(page.locator(".section-actions .badge")).toHaveText(
        "succeeded",
      );
    else {
      await expect(
        page.getByText("The external result is uncertain.", { exact: true }),
      ).toBeVisible();
      await request.post(
        "http://127.0.0.1:4311/portal/orders/" + id + "/restore",
      );
      await page
        .getByRole("button", { name: "Check again", exact: true })
        .click();
      await page
        .getByLabel("Reason", { exact: true })
        .fill("Supplier verification endpoint restored");
      await page
        .getByRole("button", { name: "Check external result", exact: true })
        .click();
      await expect(page.locator(".section-actions .badge")).toHaveText(
        "succeeded",
      );
    }
  }
});
test("workspace configuration screens remain usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "supplier-api", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Usage & audit", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Verify audit chain", exact: true })
    .click();
  await expect(page.getByText("Chain verified", { exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
});
