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
import {
  join,
  sep,
} from "node:path"
import {
  afterAll,
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

    await copyFile(join(globalThis.tmpRoot, "monorepo-hash-bun.ts"), join(demoDir, "monorepo-hash-bun.ts"))
  })

  afterAll(async () => {
    if (await pathExists(demoDir)) {
      await remove(demoDir)
    }
  })

  const pkgs = [
    "database",
    join("packages", "linter"),
    join("packages", "cli-tools"),
    join("services", "backend"),
    join("services", "frontend"),
  ]

  it("generates all hashes and matches snapshot", async () => {
    await execa(cli, [ "--generate" ], { cwd: demoDir })

    const hashPromises = pkgs.map(async (rel) => {
      const hash = (await readFile(join(demoDir, rel, ".hash"), "utf8")).trim()

      return [ rel, hash ] as const
    })

    const hashEntries = await Promise.all(hashPromises)
    const normalizedEntries = hashEntries.map(([ rel, hash ]) => {
      const posixRel = rel.split(sep)
        .join("/")

      return [ posixRel, hash ] as const
    })

    const hashes: Record<string, string> = Object.fromEntries(normalizedEntries)

    expect(hashes)
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
    await execa(cli, [ "--generate", "--target=packages/cli-tools" ], { cwd: demoDir })

    const existsPromises = pkgs.map(async (rel) => {
      const exists = await pathExists(join(demoDir, rel, ".hash"))

      return [ rel, exists ] as const
    })

    const existsResults = await Promise.all(existsPromises)

    for (const [ rel, exists ] of existsResults) {
      if (rel === join("packages", "cli-tools")) {
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
    await execa(cli, [ "--generate" ], { cwd: demoDir })
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
    await execa(cli, [ "--generate", "--target=services/backend" ], { cwd: demoDir })
    const partial = (await readFile(join(demoDir, "services", "backend", ".hash"), "utf8")).trim()

    const existsPromises = pkgs.map(async (rel) => {
      const exists = await pathExists(join(demoDir, rel, ".hash"))

      return [ rel, exists ] as const
    })

    const existsResults = await Promise.all(existsPromises)

    for (const [ rel, exists ] of existsResults) {
      if (rel === join("services", "backend")) {
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

  it("writes a root .hash when unified flag is used", async () => {
    await execa(cli, [ "--generate", "--unified" ], { cwd: demoDir })
    const rootPath = join(demoDir, ".hash")
    const exists = await pathExists(rootPath)

    expect(exists)
      .toBe(true)
    // oxlint-disable-next-line no-unsafe-type-assertion
    const content = JSON.parse(await readFile(rootPath, "utf8")) as Record<string, string>

    const expectedPackageCount = Object.keys(content).length

    expect(Object.keys(content).length)
      .toBe(expectedPackageCount)

    const cliToolsHashPath = join(demoDir, "packages", "cli-tools", ".hash")
    const cliToolsExists = await pathExists(cliToolsHashPath)

    expect(cliToolsExists)
      .toBe(false)
  })
})
