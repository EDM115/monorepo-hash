import { join } from "node:path"
import { describe } from "vitest"

import { defineParityScriptProbeSuite } from "../parityScripts.shared"
import { x } from "../exec"

describe("parity script probes", () => {
  defineParityScriptProbeSuite(async (cwd, args) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
    })
  })
})
