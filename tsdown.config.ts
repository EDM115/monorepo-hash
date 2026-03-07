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
      onlyAllowBundle: false,
    },
    dts: true,
    entry: { "monorepo-hash": "./src/monorepo-hash.ts" },
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
    entry: { "install-binary": "./src/install-binary.ts" },
    exports: false,
    format: ["esm"],
    minify: true,
    nodeProtocol: true,
    platform: "node",
    shims: true,
    target: [ "ESNext", "Node22" ],
  },
])
