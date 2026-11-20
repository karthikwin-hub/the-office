import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8790);

/**
 * One owner's whole journey through the real Worker on this machine (serve.mjs), in Chromium, one test at a time:
 * the tests share one office, and the machine runs one browser. Traces are kept only for a failure.
 */
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Where Playwright cannot download its own Chromium (a newer Linux than it knows), point CHROMIUM at an installed one.
    launchOptions: { executablePath: process.env.CHROMIUM || undefined },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } }],
  webServer: {
    command: "node serve.mjs",
    url: `http://localhost:${PORT}/api/me`,
    // /api/me answers 401 until someone signs in; any answer means the Worker is up.
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
