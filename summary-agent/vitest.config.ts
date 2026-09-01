import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one Postgres database; run files serially so
    // per-file TRUNCATE in beforeEach never races another file.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Pin the drivers so the suite is deterministic no matter what .env holds.
    // dotenv.config() won't override these. Tests inject their own fs store +
    // mock LLM anyway; the real-LLM suite reads OPENROUTER_API_KEY directly.
    env: { STORAGE_DRIVER: "fs", LLM_DRIVER: "mock" },
  },
});
