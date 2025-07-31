import { defineConfig } from "tsdown"

export default defineConfig({
  banner: {
    js: "#!/usr/bin/env node"
  },
  dts: true,
  entry: {
    "monorepo-hash": "./src/monorepo-hash.ts",
  },
  exports: true,
  format: [ "esm" ],
  minify: true,
  noExternal: [
    "fast-glob",
    "find-up",
    "ignore",
    "js-yaml",
  ],
  platform: "node",
  shims: true,
  target: [ "esnext", "node20" ],
  unused: true,
})
