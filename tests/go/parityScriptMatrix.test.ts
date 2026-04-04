import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptMatrixSnapshotSuite } from "../harnesses/parityScriptMatrix.shared"

describe("parity script matrix", () => {
  defineParityScriptMatrixSnapshotSuite("go", async (cwd, args, options?) => {
    const cliBinary = join(globalThis.tmpRoot, "go", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
