import { defineConfig } from "vitest/config"

export default defineConfig({ test: {
  detectAsyncLeaks: true,
  experimental: {
    importDurations: {
      print: true,
    },
  },
  include: ["tests-binaries/**/*.test.ts"],
  logHeapUsage: true,
  open: false,
  pool: "threads",
  reporters: process.env.GITHUB_ACTIONS === "true"
    ? [ "dot", "tree", "github-actions" ]
    : [ "dot", "tree" ],
  setupFiles: ["tests-binaries/setup.ts"],
  typecheck: { enabled: true },
  watch: false,
} })
