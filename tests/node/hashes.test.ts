import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

import { x } from "../exec"
import { defineHashesSuite } from "../harnesses/hashes.shared"
import {
  mkdirp,
  remove,
} from "../utils"

describe("hash generation", () => {
  defineHashesSuite(async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })
})

describe("hash computation functions", () => {
  let cliScript: string
  let cwd: string
  let cliImport: string
  const cli = "node"
  const created: string[] = []

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "node", "monorepo-hash.mjs")
    cliImport = pathToFileURL(cliScript).href
  })

  afterEach(async () => {
    const toRemove = created.splice(0)

    await Promise.all(toRemove.map((d) => remove(d)))
  })

  describe("computePerFileHashes", () => {
    it("computes hashes for files in a directory", async () => {
      const testDir = join(tmpdir(), `test-hash-${Date.now()}`)

      created.push(testDir)
      await mkdirp(testDir)
      await writeFile(join(testDir, "file1.txt"), "content1")
      await writeFile(join(testDir, "file2.txt"), "content2")
      const harness = join(cwd, "perFileHashes1.mjs")

      created.push(harness)
      const escapedDir = testDir.replace(/\\/g, "\\\\")

      await writeFile(harness, `import { computePerFileHashes } from "${cliImport}"
const result = await computePerFileHashes("${escapedDir}", ["file1.txt", "file2.txt"])
console.log(JSON.stringify(Object.keys(result).sort()))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(JSON.parse(stdout))
        .toEqual([ "file1.txt", "file2.txt" ])
    })

    it("returns empty object for empty file list", async () => {
      const testDir = join(tmpdir(), `test-hash-empty-${Date.now()}`)

      created.push(testDir)
      await mkdirp(testDir)
      const harness = join(cwd, "perFileHashes2.mjs")

      created.push(harness)
      const escapedDir = testDir.replace(/\\/g, "\\\\")

      await writeFile(harness, `import { computePerFileHashes } from "${cliImport}"
const result = await computePerFileHashes("${escapedDir}", [])
console.log(JSON.stringify(result))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(JSON.parse(stdout))
        .toEqual({})
    })

    it("produces deterministic hashes for same content", async () => {
      const testDir = join(tmpdir(), `test-hash-det-${Date.now()}`)

      created.push(testDir)
      await mkdirp(testDir)
      await writeFile(join(testDir, "file.txt"), "deterministic content")
      const harness = join(cwd, "perFileHashes3.mjs")

      created.push(harness)
      const escapedDir = testDir.replace(/\\/g, "\\\\")

      await writeFile(harness, `import { computePerFileHashes } from "${cliImport}"
const result1 = await computePerFileHashes("${escapedDir}", ["file.txt"])
const result2 = await computePerFileHashes("${escapedDir}", ["file.txt"])
console.log(result1["file.txt"] === result2["file.txt"])`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("true")
    })
  })

  describe("computeOwnHashFromPerFile", () => {
    it("combines per-file hashes into a single hash", async () => {
      const harness = join(cwd, "ownHash1.mjs")

      created.push(harness)
      await writeFile(harness, `import { computeOwnHashFromPerFile } from "${cliImport}"
const perFileMap = {
  "a.txt": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "b.txt": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
}
const result = computeOwnHashFromPerFile(perFileMap, ["a.txt", "b.txt"])
console.log(result instanceof Buffer)`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("true")
    })

    it("produces different hashes for different key orders", async () => {
      const harness = join(cwd, "ownHash2.mjs")

      created.push(harness)
      await writeFile(harness, `import { computeOwnHashFromPerFile } from "${cliImport}"
const perFileMap = {
  "a.txt": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "b.txt": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
}
const result1 = computeOwnHashFromPerFile(perFileMap, ["a.txt", "b.txt"])
const result2 = computeOwnHashFromPerFile(perFileMap, ["b.txt", "a.txt"])
console.log(result1.toString("hex") !== result2.toString("hex"))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("true")
    })
  })
})
