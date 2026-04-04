import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptMatrixSnapshotSuite } from "../harnesses/parityScriptMatrix.shared"

describe("parity script matrix", () => {
  defineParityScriptMatrixSnapshotSuite("node", async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
