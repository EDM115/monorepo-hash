import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineParityScriptMatrixSnapshotSuite } from "../harnesses/parityScriptMatrix.shared"

describe("parity script matrix", () => {
  defineParityScriptMatrixSnapshotSuite("bun", async (cwd, args, options?) => {
    const cliBinary = join(globalThis.tmpRoot, "bun", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
      ...options,
    })
  })
}, 30000)
