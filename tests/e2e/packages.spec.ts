import { test, expect } from "@playwright/test";
import Fastify from "fastify";
const provider = Fastify();
let issue: Record<string, unknown>;
test.beforeAll(async () => {
  provider.get("/user", async () => ({ id: 9, login: "test-user" }));
  provider.get("/repos/example/cases", async () => ({
    id: 20,
    full_name: "example/cases",
    has_issues: true,
  }));
  provider.post("/repos/example/cases/issues", async (req, reply) => {
    issue = {
      ...(req.body as object),
      id: 1,
      number: 1,
      user: { id: 9 },
      state: "open",
      state_reason: null,
      html_url: "https://github.com/example/cases/issues/1",
    };
    reply.hijack();
    reply.raw.destroy();
  });
  provider.get("/repos/example/cases/issues", async () =>
    issue ? [issue] : [],
  );
  provider.get("/repos/example/cases/issues/1", async () => issue);
  await provider.listen({ host: "127.0.0.1", port: 4312 });
});
test.afterAll(async () => {
  await provider.close();
});
test("install, connect, create after lost response, and wait for completed closure", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  const c = await page.request.post("/api/v1/connectors", {
    data: {
      name: "github-ui-" + Date.now(),
      kind: "http",
      baseUrl: "http://127.0.0.1:4312",
    },
  });
  const connection = await c.json();
  expect(c.status()).toBe(201);
  await page.getByRole("link", { name: "Packages", exact: true }).click();
  await page.getByRole("button", { name: "Install GitHub package" }).click();
  await page
    .getByLabel("Connection", { exact: true })
    .selectOption(connection.id);
  const name = "github-ui-" + Date.now();
  await page.getByLabel("Operation name", { exact: true }).fill(name);
  await page.getByLabel("Repository owner").fill("example");
  await page.getByLabel("Repository name").fill("cases");
  await page.getByLabel("Require approval before creating an issue").uncheck();
  await page
    .getByLabel("Wait for the issue to be closed as completed (up to 7 days)")
    .check();
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Connected as test-user",
  );
  await page
    .getByRole("button", { name: "Install package", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Package installed", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card).toBeVisible();
  await page.screenshot({
    path: "test-results/packages-desktop.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "Run operation" }).click();
  await page
    .getByLabel("Case ID", { exact: true })
    .fill("case-ui-\u03b1-" + Date.now());
  await page
    .getByLabel("Issue title", { exact: true })
    .fill("Investigate a customer case");
  await page
    .getByLabel("Issue description")
    .fill("Reproduce and resolve the reported problem.");
  await page.getByRole("button", { name: "Submit operation" }).click();
  await expect(
    page.getByText("Waiting for an external result", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open verified issue ↗" }),
  ).toHaveAttribute("href", "https://github.com/example/cases/issues/1");
  await page.screenshot({
    path: "test-results/package-waiting.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/package-mobile.png",
    fullPage: true,
  });
  issue.state = "closed";
  issue.state_reason = "completed";
  await page.getByRole("button", { name: "Check now" }).click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Issue completed in the provider");
  await page
    .getByRole("button", { name: "Check external result", exact: true })
    .click();
  await expect(page.locator(".section-actions .badge")).toHaveText("succeeded");
  expect(errors).toEqual([]);
});
