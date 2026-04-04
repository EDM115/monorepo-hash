import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineEdgeCasesSuite } from "../harnesses/edgeCases.shared"

describe("edge cases", () => {
  defineEdgeCasesSuite(async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
