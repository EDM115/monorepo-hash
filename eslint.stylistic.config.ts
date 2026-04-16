import stylistic from "@stylistic/eslint-plugin"
import tsParser from "@typescript-eslint/parser"

import { eslint as edm115Lint } from "edm115-lint"

export default [
  { ignores: [ "bun-build", "dist", "go-build", "rust-build", "**/node_modules/", "tests/demo", "bench-history", "bench-history-new", "manifests", "src/go", "src/rust" ] },
  {
    files: ["**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
    },
    plugins: { "@stylistic": stylistic },
    rules: edm115Lint,
  },
]
