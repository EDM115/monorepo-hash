import { defineConfig } from "vitest/config"

export default defineConfig({ test: {
  include: ["tests/**/*.test.ts"],
  logHeapUsage: true,
  open: false,
  pool: "threads",
  reporters: ["verbose"],
  setupFiles: ["tests/setup.ts"],
  typecheck: { enabled: true },
  watch: false,
} })
