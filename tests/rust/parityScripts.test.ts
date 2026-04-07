import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptProbeSuite } from "../harnesses/parityScripts.shared"

describe("parity script probes", () => {
  defineParityScriptProbeSuite(async (cwd, args, options?) => {
    const cliBinary = join(globalThis.tmpRoot, "rust", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
