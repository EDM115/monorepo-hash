import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptMatrixSnapshotSuite } from "../parityScriptMatrix.shared"

describe("parity script matrix", () => {
  defineParityScriptMatrixSnapshotSuite("node", async (cwd, args) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
    })
  })
})
