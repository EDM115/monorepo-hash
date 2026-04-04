import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineDebugSuite } from "../harnesses/debug.shared"

describe("debug mode", () => {
  defineDebugSuite(async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
