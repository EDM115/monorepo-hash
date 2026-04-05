import {
  readFile,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

import {
  pathExists,
  remove,
} from "../utils"
import type { RunCli } from "./types"

export function defineDebugSuite(runCli: RunCli): void {
  let cwd: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
  })

  describe("unified", () => {
    it("does not report missing workspace debug files when root .debug-hash is absent", async () => {
      const rootDebug = join(cwd, ".debug-hash")

      if (await pathExists(rootDebug)) {
        await remove(rootDebug)
      }

      await runCli(cwd, ["--generate"])
      const result = await runCli(cwd, [ "--compare", "--debug" ])

      expect(result.exitCode)
        .toBe(0)
      expect(result.stdout)
        .not.toContain("has no .debug-hash to compare")
    })

    it("creates root .debug-hash file and reports mismatched files", async () => {
      await runCli(cwd, [ "--generate", "--debug" ])
      const rootDebug = join(cwd, ".debug-hash")

      expect(await pathExists(rootDebug))
        .toBe(true)

      const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

      await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")

      const result = await runCli(cwd, [ "--compare", "--debug" ])

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

      await runCli(cwd, [ "--generate", "--debug" ])

      expect(await pathExists(rootDebug))
        .toBe(true)

      const pkgADebugExists = await pathExists(pkgADebugPath)

      expect(pkgADebugExists)
        .toBe(false)
    })

    it("writes root .debug-hash entries sorted by workspace and file keys", async () => {
      await runCli(cwd, [ "--generate", "--debug" ])

      const rootDebug = join(cwd, ".debug-hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootDebug, "utf8")) as Record<string, Record<string, string>>
      const workspaceKeys = Object.keys(content)

      expect(workspaceKeys)
        .toEqual([...workspaceKeys].toSorted())

      for (const workspaceKey of workspaceKeys) {
        const fileKeys = Object.keys(content[workspaceKey] ?? {})

        expect(fileKeys)
          .toEqual([...fileKeys].toSorted())
      }
    })
  })

  describe("workspaces", () => {
    it("creates .debug-hash files and reports mismatched files", async () => {
      await runCli(cwd, [ "--generate", "--debug", "--workspaces" ])

      const aDebug = join(cwd, "packages", "pkg-a", ".debug-hash")
      const bDebug = join(cwd, "packages", "pkg-b", ".debug-hash")

      expect(await pathExists(aDebug))
        .toBe(true)
      expect(await pathExists(bDebug))
        .toBe(true)

      const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

      await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited again)\"\n")

      const result = await runCli(cwd, [ "--compare", "--debug" ])

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

      await runCli(cwd, [ "--generate", "--debug", "--workspaces" ])

      expect(await pathExists(rootDebug))
        .toBe(false)

      const pkgADebugPath = join(cwd, "packages", "pkg-a", ".debug-hash")
      const pkgADebugExists = await pathExists(pkgADebugPath)

      expect(pkgADebugExists)
        .toBe(true)
    })

    it("writes per-workspace .debug-hash entries sorted by file keys", async () => {
      await runCli(cwd, [ "--generate", "--debug", "--workspaces" ])

      for (const pkg of [ "pkg-a", "pkg-b", "pkg-c" ]) {
        const debugPath = join(cwd, "packages", pkg, ".debug-hash")
        // oxlint-disable-next-line no-unsafe-type-assertion no-await-in-loop
        const content = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, string>
        const fileKeys = Object.keys(content)

        expect(fileKeys)
          .toEqual([...fileKeys].toSorted())
      }
    })
  })
}
