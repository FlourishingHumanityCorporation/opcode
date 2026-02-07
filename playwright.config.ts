import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/smoke",
  fullyParallel: false,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1420",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
