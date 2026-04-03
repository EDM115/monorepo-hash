import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptMatrixSnapshotSuite } from "../parityScriptMatrix.shared"

describe("parity script matrix", () => {
  defineParityScriptMatrixSnapshotSuite("go", async (cwd, args) => {
    const cliBinary = join(globalThis.tmpRoot, "go", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
    })
  })
})
