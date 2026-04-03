import { join } from "node:path"
import { describe } from "vitest"

import { defineParityScriptProbeSuite } from "../parityScripts.shared"
import { x } from "../exec"

describe("parity script probes", () => {
  defineParityScriptProbeSuite(async (cwd, args) => {
    const cliBinary = join(globalThis.tmpRoot, "bun", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
    })
  })
})
