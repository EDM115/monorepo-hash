import { join } from "node:path"
import { describe } from "vitest"

import { x } from "../exec"
import { defineOutputSuite } from "../harnesses/output.shared"

describe("monorepo-hash CLI output", () => {
  defineOutputSuite(async (cwd, args, options?) => {
    const cliBinary = join(globalThis.tmpRoot, "bun", "monorepo-hash.exe")

    return x(cliBinary, args, {
      nodeOptions: { cwd },
      ...options,
    })
  })
}, 30000)
