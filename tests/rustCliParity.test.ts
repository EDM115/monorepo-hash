import {
  readFile,
  rm,
} from "node:fs/promises"
import { join } from "node:path"
import { x } from "tinyexec"
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("rust cli parity", () => {
  let cwd: string
  let cliScript: string
  let rustManifest: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash.mjs")
    rustManifest = join(process.cwd(), "src", "rust", "Cargo.toml")
  })

  it("produces the same unified hash map as the JS implementation", async () => {
    await x("node", [ cliScript, "--generate", "--silent" ], {
      nodeOptions: { cwd },
    })

    const jsHash = await readFile(join(cwd, ".hash"), "utf8")

    await rm(join(cwd, ".hash"))

    await x("cargo", [
      "run",
      "--quiet",
      "--manifest-path",
      rustManifest,
      "--",
      "--generate",
      "--silent",
    ], {
      nodeOptions: { cwd },
      timeout: 120_000,
    })

    const rustHash = await readFile(join(cwd, ".hash"), "utf8")

    expect(rustHash)
      .not
      .toHaveLength(0)
    expect(JSON.parse(rustHash))
      .toEqual(JSON.parse(jsHash))
  })
})
