import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { x } from "tinyexec"
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

import {
  pathExists,
  remove,
} from "../tests/utils"

describe("debug mode", () => {
  let cwd: string
  let cli: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cli = join(cwd, "monorepo-hash.exe")
  })

  describe("unified", () => {
    it("creates root .debug-hash file and reports mismatched files", async () => {
      await x(cli, [ "--generate", "--debug" ], { nodeOptions: { cwd } })

      const rootDebug = join(cwd, ".debug-hash")

      expect(await pathExists(rootDebug))
        .toBe(true)

      const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

      await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")

      const result = await x(cli, [ "--compare", "--debug" ], { nodeOptions: { cwd } },
      )

      expect(result.stdout)
        .toMatch(new RegExp("⚠️\\s+<debug>\\s+packages\\/pkg-b\\s+diverging files\\s*:"))
      expect(result.stdout)
        .toContain("• index.js")
      expect(result.exitCode)
        .toBe(1)
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

      await x(cli, [ "--generate", "--debug" ], { nodeOptions: { cwd } })

      expect(await pathExists(rootDebug))
        .toBe(true)

      const pkgADebugExists = await pathExists(pkgADebugPath)

      expect(pkgADebugExists)
        .toBe(false)
    })
  })

  describe("workspaces", () => {
    it("creates .debug-hash files and reports mismatched files", async () => {
      await x(cli, [ "--generate", "--debug", "--workspaces" ], { nodeOptions: { cwd } })

      const aDebug = join(cwd, "packages", "pkg-a", ".debug-hash")
      const bDebug = join(cwd, "packages", "pkg-b", ".debug-hash")

      expect(await pathExists(aDebug))
        .toBe(true)
      expect(await pathExists(bDebug))
        .toBe(true)

      const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

      await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited again)\"\n")

      const result = await x(cli, [ "--compare", "--debug" ], { nodeOptions: { cwd } })

      expect(result.stdout)
        .toMatch(new RegExp("⚠️\\s+<debug>\\s+packages\\/pkg-b\\s+diverging files\\s*:"))
      expect(result.stdout)
        .toContain("• index.js")
      expect(result.exitCode)
        .toBe(1)
    })

    it("writes separate debug info", async () => {
      const rootDebug = join(cwd, ".debug-hash")

      if (await pathExists(rootDebug)) {
        await remove(rootDebug)
      }

      await x(cli, [ "--generate", "--debug", "--workspaces" ], { nodeOptions: { cwd } })

      expect(await pathExists(rootDebug))
        .toBe(false)

      const pkgADebugPath = join(cwd, "packages", "pkg-a", ".debug-hash")
      const pkgADebugExists = await pathExists(pkgADebugPath)

      expect(pkgADebugExists)
        .toBe(true)
    })
  })
})
