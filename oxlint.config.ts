import { defineConfig } from "oxlint"
import { oxlint as edm115Lint } from "edm115-lint"

export default defineConfig({
  "env": {
    es2025: true,
    node: true,
  },
  "extends": [edm115Lint],
  "ignorePatterns": [
    "**/bun-build/",
    "**/dist/",
    "**/node_modules/",
    "tests/demo",
    "bench-history",
    "bench-history-new",
    "manifests",
  ],
  "options": {
    typeAware: true,
  },
  "rules": {
    "typescript/consistent-return": "off",
  },
})
