import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptProbeSuite } from "../harnesses/parityScripts.shared"

describe("parity script probes", () => {
  defineParityScriptProbeSuite(async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
