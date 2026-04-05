import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineExitCodesSuite } from "../harnesses/exitCodes.shared"

describe("exit codes", () => {
  defineExitCodesSuite(async (cwd, args, options?) => {
    const cliBinary = join(globalThis.tmpRoot, "rust", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
      ...options,
    })
  })
})
