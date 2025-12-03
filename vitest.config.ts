import { defineConfig } from "vitest/config"

export default defineConfig({ test: {
  experimental: {
    printImportBreakdown: true,
  },
  include: ["tests/**/*.test.ts"],
  logHeapUsage: true,
  open: false,
  pool: "threads",
  reporters: ["tree"],
  setupFiles: ["tests/setup.ts"],
  typecheck: { enabled: true },
  watch: false,
} })
