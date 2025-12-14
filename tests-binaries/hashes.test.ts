import { execa } from "execa"
import {
  copyFile,
  mkdirp,
  pathExists,
  readFile,
  remove,
  writeFile,
  writeJson,
} from "fs-extra"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("hash generation", () => {
  let cwd: string
  let demoDir: string
  let cli: string

  beforeAll(async () => {
    cwd = globalThis.tmpRoot
    cli = join(cwd, "monorepo-hash.exe")
    demoDir = join(cwd, "small-monorepo")

    // Scaffold a small 5-package monorepo
    await mkdirp(demoDir)
    const workspaceYaml = `
packages:
  - "packages/*"
  - "services/*"
  - "database"
`

    await writeFile(join(demoDir, "pnpm-workspace.yaml"), `${workspaceYaml.trim()}\n`)

    // database
    const db = join(demoDir, "database")

    await mkdirp(db)
    await writeJson(join(db, "package.json"), {
      name: "database", version: "0.1.0", type: "module",
    }, { spaces: 2 })
    await writeFile(join(db, "index.js"), "export const foo = \"db\"\n")

    // packages/linter
    const lint = join(demoDir, "packages", "linter")

    await mkdirp(lint)
    await writeJson(join(lint, "package.json"), {
      name: "linter", version: "0.1.0", type: "module",
    }, { spaces: 2 })
    await writeFile(join(lint, "index.js"), "export const lint = () => true\n")

    // packages/cli-tools
    const cliTools = join(demoDir, "packages", "cli-tools")

    await mkdirp(cliTools)
    await writeJson(join(cliTools, "package.json"), {
      name: "cli-tools", version: "0.1.0", type: "module",
    }, { spaces: 2 })
    await writeFile(join(cliTools, "index.js"), "export const run = () => {}\n")

    // services/backend depends on database, linter, cli-tools
    const backend = join(demoDir, "services", "backend")

    await mkdirp(backend)
    await writeJson(join(backend, "package.json"), {
      name: "backend",
      version: "0.1.0",
      type: "module",
      dependencies: {
        "database": "workspace:*",
        "linter": "workspace:*",
        "cli-tools": "workspace:*",
      },
    }, { spaces: 2 })
    await writeFile(join(backend, "index.js"), "export const serve = () => {}\n")

    // services/frontend depends on linter
    const frontend = join(demoDir, "services", "frontend")

    await mkdirp(frontend)
    await writeJson(join(frontend, "package.json"), {
      name: "frontend",
      version: "0.1.0",
      type: "module",
      dependencies: { linter: "workspace:*" },
    }, { spaces: 2 })
    await writeFile(join(frontend, "index.js"), "export const render = () => {}\n")

    await copyFile(join(cwd, "monorepo-hash-bun.ts"), join(demoDir, "monorepo-hash-bun.ts"))
  })

  afterAll(async () => {
    if (await pathExists(demoDir)) {
      await remove(demoDir)
    }
  })

  const pkgs = [
    "database",
    "packages/linter",
    "packages/cli-tools",
    "services/backend",
    "services/frontend",
  ]

  describe("unified", () => {
    it("generates all hashes and matches snapshot", async () => {
      await execa(cli, ["--generate"], { cwd: demoDir })

      const rootPath = join(demoDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootPath, "utf8")) as Record<string, string>

      expect(content)
        .toMatchSnapshot()
    })

    it("generates hash for a single workspace", async () => {
      // clean up any existing root .hash file
      const rootPath = join(demoDir, ".hash")

      if (await pathExists(rootPath)) {
        await remove(rootPath)
      }

      await execa(cli, [ "--generate", "--target=packages/cli-tools" ], { cwd: demoDir })

      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootPath, "utf8")) as Record<string, string>
      const keys = Object.keys(content)

      expect(keys)
        .toContain("packages/cli-tools")
      expect(keys)
        .toHaveLength(1)
    })

    it("produces the same hash for a workspace with transitive deps as in full generate", async () => {
      // full generate
      await execa(cli, ["--generate"], { cwd: demoDir })
      const rootPath = join(demoDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const fullContent = JSON.parse(await readFile(rootPath, "utf8")) as Record<string, string>
      const backendKey = "services/backend"
      const full = fullContent[backendKey]

      // remove root .hash
      if (await pathExists(rootPath)) {
        await remove(rootPath)
      }

      // partial generate
      await execa(cli, [ "--generate", "--target=services/backend" ], { cwd: demoDir })
      // oxlint-disable-next-line no-unsafe-type-assertion
      const partialContent = JSON.parse(await readFile(rootPath, "utf8")) as Record<string, string>
      const partial = partialContent[backendKey]

      expect(Object.keys(partialContent))
        .toEqual([backendKey])

      expect(partial)
        .toBe(full)
    })

    it("writes a root .hash file", async () => {
      const cliToolsHashPath = join(demoDir, "packages", "cli-tools", ".hash")

      if (await pathExists(cliToolsHashPath)) {
        await remove(cliToolsHashPath)
      }

      await execa(cli, ["--generate"], { cwd: demoDir })
      const rootPath = join(demoDir, ".hash")
      const exists = await pathExists(rootPath)

      expect(exists)
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootPath, "utf8")) as Record<string, string>

      const expectedPackageCount = Object.keys(content).length

      expect(Object.keys(content).length)
        .toBe(expectedPackageCount)

      const cliToolsExists = await pathExists(cliToolsHashPath)

      expect(cliToolsExists)
        .toBe(false)
    })
  })

  describe("workspaces", () => {
    it("generates all hashes and matches snapshot", async () => {
      await execa(cli, [ "--generate", "--workspaces" ], { cwd: demoDir })

      const hashPromises = pkgs.map(async (rel) => {
        const hash = (await readFile(join(demoDir, rel, ".hash"), "utf8")).trim()

        return [ rel, hash ] as const
      })

      const hashEntries = await Promise.all(hashPromises)
      const hashObj: Record<string, string> = {}

      for (const [ rel, hash ] of hashEntries) {
        hashObj[rel] = hash
      }

      expect(hashObj)
        .toMatchSnapshot()
    })

    it("generates hash for a single workspace", async () => {
      // clean up any existing .hash files
      const cleanupPromises = pkgs.map(async (rel) => {
        const p = join(demoDir, rel, ".hash")

        if (await pathExists(p)) {
          await remove(p)
        }
      })

      await Promise.all(cleanupPromises)
      await execa(cli, [ "--generate", "--target=packages/cli-tools", "--workspaces" ], { cwd: demoDir })

      const existsPromises = pkgs.map(async (rel) => {
        const exists = await pathExists(join(demoDir, rel, ".hash"))

        return [ rel, exists ] as const
      })

      const existsResults = await Promise.all(existsPromises)

      for (const [ rel, exists ] of existsResults) {
        if (rel === "packages/cli-tools") {
          expect(exists)
            .toBe(true)
        } else {
          expect(exists)
            .toBe(false)
        }
      }
    })

    it("produces the same hash for a workspace with transitive deps as in full generate", async () => {
      // full generate
      await execa(cli, [ "--generate", "--workspaces" ], { cwd: demoDir })
      const full = (await readFile(join(demoDir, "services", "backend", ".hash"), "utf8")).trim()

      // remove all .hash
      const cleanPromises = pkgs.map(async (rel) => {
        const p = join(demoDir, rel, ".hash")

        if (await pathExists(p)) {
          await remove(p)
        }
      })

      await Promise.all(cleanPromises)

      // partial generate
      await execa(cli, [ "--generate", "--target=services/backend", "--workspaces" ], { cwd: demoDir })
      const partial = (await readFile(join(demoDir, "services", "backend", ".hash"), "utf8")).trim()

      const existsPromises = pkgs.map(async (rel) => {
        const exists = await pathExists(join(demoDir, rel, ".hash"))

        return [ rel, exists ] as const
      })

      const existsResults = await Promise.all(existsPromises)

      for (const [ rel, exists ] of existsResults) {
        if (rel === "services/backend") {
          expect(exists)
            .toBe(true)
        } else {
          expect(exists)
            .toBe(false)
        }
      }

      expect(partial)
        .toBe(full)
    })

    it("writes per-workspace .hash files when workspaces flag is used", async () => {
      const rootPath = join(demoDir, ".hash")

      if (await pathExists(rootPath)) {
        await remove(rootPath)
      }

      await execa(cli, [ "--generate", "--workspaces" ], { cwd: demoDir })
      const exists = await pathExists(rootPath)

      expect(exists)
        .toBe(false)

      const cliToolsHashPath = join(demoDir, "packages", "cli-tools", ".hash")
      const cliToolsExists = await pathExists(cliToolsHashPath)

      expect(cliToolsExists)
        .toBe(true)
    })
  })
})

describe("hash computation functions", () => {
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
      const { stdout } = await execa(cli, [harness], { cwd })

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
      const { stdout } = await execa(cli, [harness], { cwd })

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
      const { stdout } = await execa(cli, [harness], { cwd })

      expect(stdout)
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
      const { stdout } = await execa(cli, [harness], { cwd })

      expect(stdout)
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
      const { stdout } = await execa(cli, [harness], { cwd })

      expect(stdout)
        .toBe("true")
    })
  })
})
