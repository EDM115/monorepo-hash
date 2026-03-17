import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

import { x } from "./exec"
import { remove } from "../tests/utils"

describe("utility functions", () => {
  let cliScript: string
  let cwd: string
  let cliImport: string
  const cli = "bun"
  const created: string[] = []

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash-bun.ts")
    cliImport = pathToFileURL(cliScript).href
  })

  afterEach(async () => {
    const toRemove = created.splice(0)

    await Promise.all(toRemove.map((d) => remove(d)))
  })

  describe("displayPath", () => {
    it("normalizes Windows paths to POSIX style", async () => {
      const harness = join(cwd, "displayPath.mjs")

      created.push(harness)
      await writeFile(harness, `import { createRequire } from "node:module"        
const require = createRequire(import.meta.url)
// spoof Node's path.sep on Linux/Mac for testing
const path = require("node:path")
path.sep = "\\\\"
const { displayPath } = await import("${cliImport}")
console.log(displayPath("packages\\\\pkg-a\\\\src\\\\index.ts"))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("packages/pkg-a/src/index.ts")
    })

    it("returns POSIX paths unchanged", async () => {
      const harness = join(cwd, "displayPath2.mjs")

      created.push(harness)
      await writeFile(harness, `import { displayPath } from "${cliImport}"
console.log(displayPath("packages/pkg-a/src/index.ts"))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("packages/pkg-a/src/index.ts")
    })
  })

  describe("exists", () => {
    it("returns true for existing files", async () => {
      const harness = join(cwd, "exists1.mjs")

      created.push(harness)
      await writeFile(harness, `import { exists } from "${cliImport}"
const result = await exists("${cliScript.replace(/\\/g, "\\\\")}")
console.log(result)`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("true")
    })

    it("returns false for non-existing files", async () => {
      const harness = join(cwd, "exists2.mjs")

      created.push(harness)
      await writeFile(harness, `import { exists } from "${cliImport}"
const result = await exists("${join(cwd, "non-existent-file.txt")
  .replace(/\\/g, "\\\\")}")
console.log(result)`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("false")
    })
  })

  describe("zeroPad", () => {
    it("pads single digit numbers", async () => {
      const harness = join(cwd, "zeroPad1.mjs")

      created.push(harness)
      await writeFile(harness, `import { zeroPad } from "${cliImport}"
console.log(zeroPad(5, 3))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("005")
    })

    it("handles numbers that are already padded", async () => {
      const harness = join(cwd, "zeroPad2.mjs")

      created.push(harness)
      await writeFile(harness, `import { zeroPad } from "${cliImport}"
console.log(zeroPad(100, 3))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("100")
    })
  })

  describe("isPackageManager", () => {
    it("returns true for valid package managers", async () => {
      const harness = join(cwd, "isPM1.mjs")

      created.push(harness)
      await writeFile(harness, `import { isPackageManager } from "${cliImport}"
const pms = ["pnpm", "npm", "yarn", "bun", "deno"]
console.log(pms.every(isPackageManager))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("true")
    })

    it("returns false for invalid package managers", async () => {
      const harness = join(cwd, "isPM2.mjs")

      created.push(harness)
      await writeFile(harness, `import { isPackageManager } from "${cliImport}"
console.log(isPackageManager("edm115"))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(stdout.trim())
        .toBe("false")
    })
  })

  describe("mapLimit", () => {
    it("processes items with concurrency limit", async () => {
      const harness = join(cwd, "mapLimit1.mjs")

      created.push(harness)
      await writeFile(harness, `import { mapLimit } from "${cliImport}"
const items = [1, 2, 3, 4, 5]
const results = await mapLimit(items, 2, async (x) => x * 2)
console.log(JSON.stringify(results))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(JSON.parse(stdout))
        .toEqual([ 2, 4, 6, 8, 10 ])
    })

    it("handles empty arrays", async () => {
      const harness = join(cwd, "mapLimit2.mjs")

      created.push(harness)
      await writeFile(harness, `import { mapLimit } from "${cliImport}"
const results = await mapLimit([], 2, async (x) => x * 2)
console.log(JSON.stringify(results))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(JSON.parse(stdout))
        .toEqual([])
    })

    it("handles concurrency limit larger than array", async () => {
      const harness = join(cwd, "mapLimit3.mjs")

      created.push(harness)
      await writeFile(harness, `import { mapLimit } from "${cliImport}"
const items = [1, 2]
const results = await mapLimit(items, 10, async (x) => x * 3)
console.log(JSON.stringify(results))`)
      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      expect(JSON.parse(stdout))
        .toEqual([ 3, 6 ])
    })
  })
})
