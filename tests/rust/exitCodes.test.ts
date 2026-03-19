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

describe("exit codes", () => {
  let cwd: string
  let cli: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cli = join(cwd, "rust", "monorepo-hash.exe")
  })

  it("returns 0 for --help", async () => {
    const result = await x(cli, ["--help"], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(0)
  })

  it("returns 2 when no mode is specified", async () => {
    const result = await x(cli, [], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(2)
  })

  it("returns 2 when both --generate and --compare are specified", async () => {
    const result = await x(cli, [ "--generate", "--compare" ], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(2)
  })

  it("returns 3 for unknown option", async () => {
    const result = await x(cli, ["--edm115"], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(3)
  })

  it("returns 4 when no workspaces can be found", async () => {
    const workspaceFilePath = join(cwd, "pnpm-workspace.yaml")
    const workspaceContent = await readFile(workspaceFilePath, "utf8")

    await remove(workspaceFilePath)
    const result = await x(cli, ["--generate"], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(4)

    await writeFile(workspaceFilePath, workspaceContent)
  })

  it("returns 5 when forcing a wrong package manager", async () => {
    const result = await x(cli, [ "--generate", "--packagemanager=yarn" ], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(5)
  })

  // technically an edge case but here since it throws an exit code
  describe("circular dependency handling", () => {
    let circularDir: string

    beforeAll(async () => {
      circularDir = join(cwd, "circular-test")
      await mkdirp(circularDir)
      const workspaceYaml = "packages:\n  - \"packages/*\""

      await writeFile(join(circularDir, "pnpm-workspace.yaml"), workspaceYaml)

      const pkgADir = join(circularDir, "packages", "pkg-circular-a")
      const pkgBDir = join(circularDir, "packages", "pkg-circular-b")

      await mkdirp(pkgADir)
      await mkdirp(pkgBDir)
      await writeJson(join(pkgADir, "package.json"), {
        name: "pkg-circular-a",
        version: "1.0.0",
        dependencies: {
          "pkg-circular-b": "workspace:*",
        },
      }, { spaces: 2 })
      await writeFile(join(pkgADir, "index.js"), "import { b } from 'pkg-circular-b'\n")
      await writeJson(join(pkgBDir, "package.json"), {
        name: "pkg-circular-b",
        version: "1.0.0",
        dependencies: {
          "pkg-circular-a": "workspace:*",
        },
      }, { spaces: 2 })
      await writeFile(join(pkgBDir, "index.js"), "import { a } from 'pkg-circular-a'\n")
    })

    afterAll(async () => {
      if (circularDir && (await pathExists(circularDir))) {
        await remove(circularDir)
      }
    })

    it("detects circular dependencies and exits with code 6", async () => {
      const result = await x(cli, ["--generate"], {
        nodeOptions: {
          cwd: circularDir,
          timeout: 30000,
        },
      })

      expect(result.exitCode)
        .toBe(6)
      expect(result.stderr)
        .toContain("Circular dependency detected")
    })

    it("reports the cycle path in the error message", async () => {
      const result = await x(cli, ["--generate"], {
        nodeOptions: { cwd: circularDir },
      })

      expect(result.exitCode)
        .toBe(6)
      // The error should show the cycle path like "pkg-circular-a -> pkg-circular-b -> pkg-circular-a"
      expect(result.stderr)
        .toMatch(/pkg-circular-[ab] -> pkg-circular-[ab]/)
    })
  })

  it("returns 99 on unexpected error", async () => {
    // Corrupt pkg-a package.json to trigger a parse error
    const packageJsonPath = join(cwd, "packages", "pkg-a", "package.json")
    const packageJsonContent = await readFile(packageJsonPath, "utf8")

    await writeFile(packageJsonPath, "{ invalid json }")
    const result = await x(cli, ["--generate"], {
      nodeOptions: { cwd },
    })

    expect(result.exitCode)
      .toBe(99)

    await writeFile(packageJsonPath, packageJsonContent)
  })
})
