import { execa } from "execa"
import {
  writeFile,
  readFile,
  remove,
} from "fs-extra"
import { join } from "node:path"
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("exit codes", () => {
  let cliScript: string
  let cwd: string
  const cli = "node"

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash.mjs")
  })

  it("returns 0 for --help", async () => {
    const result = await execa(cli, [ cliScript, "--help" ], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(0)
  })

  it("returns 2 when no mode is specified", async () => {
    const result = await execa(cli, [cliScript], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(2)
  })

  it("returns 2 when both --generate and --compare are specified", async () => {
    const result = await execa(cli, [ cliScript, "--generate", "--compare" ], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(2)
  })

  it("returns 3 for unknown option", async () => {
    const result = await execa(cli, [ cliScript, "--edm115" ], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(3)
  })

  it("returns 4 when no workspaces can be found", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    const workspaceFilePath = join(globalThis.tmpRoot, "pnpm-workspace.yaml")
    const workspaceContent = await readFile(workspaceFilePath, "utf8")

    await remove(workspaceFilePath)
    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(4)

    await writeFile(workspaceFilePath, workspaceContent)
  })

  it("returns 5 when forcing a wrong package manager", async () => {
    const result = await execa(cli, [ cliScript, "--generate", "--packagemanager=yarn" ], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(5)
  })

  it("returns 99 on unexpected error", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    // Corrupt pkg-a package.json to trigger a parse error
    const packageJsonPath = join(globalThis.tmpRoot, "packages", "pkg-a", "package.json")
    const packageJsonContent = await readFile(packageJsonPath, "utf8")

    await writeFile(packageJsonPath, "{ invalid json }")
    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd, reject: false,
    })

    expect(result.exitCode)
      .toBe(99)

    await writeFile(packageJsonPath, packageJsonContent)
  })
})
