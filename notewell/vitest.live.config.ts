import { defineConfig } from "vitest/config";

// Tests that download real models or call real APIs; run explicitly.
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    testTimeout: 600_000,
  },
});
