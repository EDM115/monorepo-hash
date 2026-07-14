import {
  mkdtemp,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  describe,
  expect,
  it,
} from "vitest"

import { x } from "../exec"
import { defineExitCodesSuite } from "../harnesses/exitCodes.shared"
import { remove } from "../utils"

describe("exit codes", () => {
  defineExitCodesSuite(async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })

  it("returns after programmatic --help without continuing into workspace detection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "monorepo-hash-programmatic-help-"))
    const harness = join(cwd, "programmatic-help.mjs")
    const cliImport = pathToFileURL(join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")).href

    try {
      await writeFile(harness, `import { runCli } from "${cliImport}"
await runCli(["--help"])
console.log("PROGRAMMATIC_HELP_RETURNED")`)

      const result = await x("node", [harness], { nodeOptions: { cwd } })

      expect(result.exitCode)
        .toBe(0)
      expect(result.stdout)
        .toContain("PROGRAMMATIC_HELP_RETURNED")
      expect(result.stderr)
        .not.toContain("No workspaces found")
    } finally {
      await remove(cwd)
    }
  })
})
