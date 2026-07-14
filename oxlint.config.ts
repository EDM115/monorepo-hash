import { defineConfig } from "oxlint"
import { oxlint as edm115Lint } from "edm115-lint"

export default defineConfig({
  "env": {
    es2026: true,
    node: true,
  },
  "extends": [edm115Lint],
  "ignorePatterns": [
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
    "eslint/no-underscore-dangle": "off",
    "typescript/consistent-return": "off",
  },
})
