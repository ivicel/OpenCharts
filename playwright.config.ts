import { defineConfig } from "@playwright/test";

/**
 * Browser-level checks for the interactive parts of the terminal.
 *
 * The unit suites cover the pure logic (replay state machine, candle cache,
 * paper engine); they cannot tell whether clicking the chart actually picks a
 * starting bar or whether the viewport follows the cursor. That is what this
 * config is for.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    // Use the full chromium build: `npx playwright install chromium` may have
    // fetched only that one, and the headless shell is a separate download.
    channel: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    // Bind IPv4 explicitly: Vite's default `localhost` can resolve to ::1 only,
    // which makes Playwright's readiness probe against 127.0.0.1 hang.
    //
    // `VITE_MARKET_SOURCE=bundled` keeps these tests off the public exchange
    // endpoint. Browser suites must not depend on a third party's uptime or
    // rate limits — the live path is covered by the Node integration tests in
    // src/__tests__/market-source.integration.test.ts.
    command: "npx vite --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000,
    env: { VITE_MARKET_SOURCE: "bundled" },
  },
});
