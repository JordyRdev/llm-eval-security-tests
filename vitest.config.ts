import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/setup/build-test-dbs.ts"],
    testTimeout: 15_000,
    passWithNoTests: true,
  },
});
