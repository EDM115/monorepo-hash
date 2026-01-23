import { defineConfig } from "tsdown"

export default defineConfig([
  {
    banner: { js: "#!/usr/bin/env node" },
    dts: true,
    entry: { "monorepo-hash": "./src/monorepo-hash.ts" },
    exports: false,
    format: ["esm"],
    inlineOnly: false,
    minify: true,
    nodeProtocol: true,
    noExternal: [
      "fast-glob",
      "find-up",
      "ignore",
      "js-yaml",
    ],
    platform: "node",
    shims: true,
    target: [ "ESNext", "Node20" ],
    unused: true,
  },
  {
    banner: { js: "#!/usr/bin/env node" },
    dts: true,
    entry: { "install-binary": "./src/install-binary.ts" },
    exports: false,
    format: ["esm"],
    minify: true,
    nodeProtocol: true,
    platform: "node",
    shims: true,
    target: [ "ESNext", "Node20" ],
  },
])
