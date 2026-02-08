import { defineConfig } from "@playwright/test";

const baseURL = process.env.REMOTE_WEB_BASE_URL ?? "http://127.0.0.1:8090";
const skipWebServer = process.env.PLAYWRIGHT_REMOTE_SKIP_WEBSERVER === "1";

export default defineConfig({
  testDir: "./tests/smoke",
  fullyParallel: false,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
  },
  ...(skipWebServer
    ? {}
    : {
        webServer: {
          command:
            process.env.REMOTE_WEB_SERVER_COMMAND ??
            "npm run build && cd src-tauri && cargo run --bin opcode-web -- --port 8090",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 600_000,
        },
      }),
});
