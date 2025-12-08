import { execa } from "execa"
import {
  pathExists,
  remove,
  writeFile,
} from "fs-extra"
import {
  join,
  sep,
} from "node:path"
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("debug mode", () => {
  let cliScript: string
  let cwd: string
  const cli = "node"

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash.mjs")
  })

  it("creates root .debug-hash file and reports mismatched files", async () => {
    await execa(cli, [ cliScript, "--generate", "--debug" ], { cwd })

    const rootDebug = join(cwd, ".debug-hash")

    expect(await pathExists(rootDebug))
      .toBe(true)

    const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

    await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")

    const result = await execa(
      cli,
      [ cliScript, "--compare", "--debug" ],
      {
        cwd, reject: false, all: true,
      },
    )

    expect(result.all)
      .toMatch(new RegExp(`⚠️\\s+<debug>\\s+packages\\${sep}pkg-b\\s+diverging files\\s*:`))
    expect(result.all)
      .toContain("• index.js")
    expect(result.exitCode)
      .toBe(1)
  })

  it("creates .debug-hash files on workspaces mode and reports mismatched files", async () => {
    await execa(cli, [ cliScript, "--generate", "--debug", "--workspaces" ], { cwd })

    const aDebug = join(cwd, "packages", "pkg-a", ".debug-hash")
    const bDebug = join(cwd, "packages", "pkg-b", ".debug-hash")

    expect(await pathExists(aDebug))
      .toBe(true)
    expect(await pathExists(bDebug))
      .toBe(true)

    const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

    await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")

    const result = await execa(
      cli,
      [ cliScript, "--compare", "--debug" ],
      {
        cwd, reject: false, all: true,
      },
    )

    expect(result.all)
      .toMatch(new RegExp(`⚠️\\s+<debug>\\s+packages\\${sep}pkg-b\\s+diverging files\\s*:`))
    expect(result.all)
      .toContain("• index.js")
    expect(result.exitCode)
      .toBe(1)
  })

  it("write separate debug info when workspaces flag is used", async () => {
    const rootDebug = join(cwd, ".debug-hash")

    if (await pathExists(rootDebug)) {
      await remove(rootDebug)
    }

    await execa(cli, [ cliScript, "--generate", "--debug", "--workspaces" ], { cwd })

    expect(await pathExists(rootDebug))
      .toBe(false)

    const pkgADebugPath = join(cwd, "packages", "pkg-a", ".debug-hash")
    const pkgADebugExists = await pathExists(pkgADebugPath)

    expect(pkgADebugExists)
      .toBe(true)
  })

  it("aggregates debug info", async () => {
    const rootDebug = join(cwd, ".debug-hash")
    const pkgADebugPath = join(cwd, "packages", "pkg-a", ".debug-hash")

    if (await pathExists(rootDebug)) {
      await remove(rootDebug)
    }

    if (await pathExists(pkgADebugPath)) {
      await remove(pkgADebugPath)
    }

    await execa(cli, [ cliScript, "--generate", "--debug" ], { cwd })

    expect(await pathExists(rootDebug))
      .toBe(true)

    const pkgADebugExists = await pathExists(pkgADebugPath)

    expect(pkgADebugExists)
      .toBe(false)
  })
})
