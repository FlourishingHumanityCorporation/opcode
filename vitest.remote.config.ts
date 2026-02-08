import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/remote-access/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
