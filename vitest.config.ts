import { defineConfig } from "vitest/config"

const shared = {
  detectAsyncLeaks: true,
  experimental: {
    importDurations: {
      print: true,
    },
  },
  logHeapUsage: true,
  pool: "threads" as const,
  typecheck: { enabled: true },
}

export default defineConfig({ test: {
  projects: [
    {
      test: {
        ...shared,
        name: "node",
        include: ["tests/node/**/*.test.ts"],
        setupFiles: ["tests/node/setup.ts"],
      },
    },
    {
      test: {
        ...shared,
        name: "go",
        include: ["tests/go/**/*.test.ts"],
        setupFiles: ["tests/go/setup.ts"],
      },
    },
    {
      test: {
        ...shared,
        name: "rust",
        include: ["tests/rust/**/*.test.ts"],
        setupFiles: ["tests/rust/setup.ts"],
      },
    },
  ],
  open: false,
  reporters:
    process.env.GITHUB_ACTIONS === "true"
      ? [ "dot", "tree", "github-actions" ]
      : [ "dot", "tree" ],
  watch: false,
} })
