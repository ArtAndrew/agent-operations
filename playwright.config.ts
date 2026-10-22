import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4310",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node dist/cli.js demo",
    url: "http://127.0.0.1:4310/readyz",
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      HOST: "127.0.0.1",
      PORT: "4310",
      DEMO_PROVIDER_PORT: "4311",
      DATA_DIR: ".data/e2e",
      NODE_ENV: "test",
    },
  },
});
