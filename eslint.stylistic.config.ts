import stylistic from "@stylistic/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import edm115Lint from "edm115-lint/eslint-stylistic.json"

export default [
  { ignores: [ "**/dist/", "**/node_modules/", "tests/demo" ] },
  {
    files: ["**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@stylistic": stylistic },
    rules: edm115Lint,
  },
]
