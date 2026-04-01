import {
  readFile,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

import { x } from "../exec"
import {
  mkdirp,
  pathExists,
  remove,
  writeJson,
} from "../utils"

describe("hash generation", () => {
  let cwd: string
  let demoDir: string
  let cli: string

  beforeAll(async () => {
    cwd = globalThis.tmpRoot
    cli = join(cwd, "bun", "monorepo-hash.exe")
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
      await x(cli, ["--generate"], { nodeOptions: { cwd: demoDir } })

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

      await x(cli, [ "--generate", "--target=packages/cli-tools" ], { nodeOptions: { cwd: demoDir } })

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
      await x(cli, ["--generate"], { nodeOptions: { cwd: demoDir } })
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
      await x(cli, [ "--generate", "--target=services/backend" ], { nodeOptions: { cwd: demoDir } })
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

      await x(cli, ["--generate"], { nodeOptions: { cwd: demoDir } })
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

    it("writes root .hash entries sorted by workspace key", async () => {
      const rootPath = join(demoDir, ".hash")

      await writeFile(rootPath, JSON.stringify({
        "zzz/legacy": "111",
        "packages/linter": "222",
        "database": "333",
      }, null, 2))

      await x(cli, [ "--generate", "--target=packages/cli-tools" ], { nodeOptions: { cwd: demoDir } })

      const raw = await readFile(rootPath, "utf8")
      const indexDatabase = raw.indexOf("\"database\"")
      const indexCliTools = raw.indexOf("\"packages/cli-tools\"")
      const indexLinter = raw.indexOf("\"packages/linter\"")
      const indexLegacy = raw.indexOf("\"zzz/legacy\"")

      expect(indexDatabase)
        .toBeGreaterThanOrEqual(0)
      expect(indexCliTools)
        .toBeGreaterThan(indexDatabase)
      expect(indexLinter)
        .toBeGreaterThan(indexCliTools)
      expect(indexLegacy)
        .toBeGreaterThan(indexLinter)
    })
  })

  describe("workspaces", () => {
    it("generates all hashes and matches snapshot", async () => {
      await x(cli, [ "--generate", "--workspaces" ], { nodeOptions: { cwd: demoDir } })

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
      await x(cli, [ "--generate", "--target=packages/cli-tools", "--workspaces" ], { nodeOptions: { cwd: demoDir } })

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
      await x(cli, [ "--generate", "--workspaces" ], { nodeOptions: { cwd: demoDir } })
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
      await x(cli, [ "--generate", "--target=services/backend", "--workspaces" ], { nodeOptions: { cwd: demoDir } })
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

      await x(cli, [ "--generate", "--workspaces" ], { nodeOptions: { cwd: demoDir } })
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
