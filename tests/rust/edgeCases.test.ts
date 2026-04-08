import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineEdgeCasesSuite } from "../harnesses/edgeCases.shared"

describe("edge cases", () => {
  defineEdgeCasesSuite(async (cwd, args, options?) => {
    const cliBinary = join(globalThis.tmpRoot, "rust", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
