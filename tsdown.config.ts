import { defineConfig } from "tsdown"

export default defineConfig([
  {
    banner: { js: "#!/usr/bin/env node" },
    deps: {
      alwaysBundle: [
        "empathic",
        "ignore",
        "tinyglobby",
        "yaml",
      ],
      onlyBundle: false,
    },
    dts: true,
    entry: { "monorepo-hash": "./src/node/monorepo-hash.ts" },
    exports: false,
    format: ["esm"],
    minify: true,
    nodeProtocol: true,
    platform: "node",
    shims: true,
    target: [ "ESNext", "Node22" ],
    unused: true,
  },
  {
    banner: { js: "#!/usr/bin/env node" },
    dts: true,
    entry: { "install-binary": "./src/node/install-binary.ts" },
    exports: false,
    format: ["esm"],
    minify: true,
    nodeProtocol: true,
    platform: "node",
    shims: true,
    target: [ "ESNext", "Node22" ],
  },
])
