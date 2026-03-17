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

import { x } from "./exec"
import {
  mkdirp,
  pathExists,
  remove,
  writeJson,
} from "../tests/utils"

describe("edge cases", () => {
  let cwd: string
  let cli: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cli = join(cwd, "monorepo-hash.exe")
  })

  describe("gitignore handling", () => {
    let gitignoreDir: string

    beforeAll(async () => {
      gitignoreDir = join(cwd, "gitignore-test")
      await mkdirp(gitignoreDir)
      await writeFile(join(gitignoreDir, ".gitignore"), "*.log\ndist/\n")
      const workspaceYaml = "packages:\n  - \"packages/*\""

      await writeFile(join(gitignoreDir, "pnpm-workspace.yaml"), workspaceYaml)

      const pkgDir = join(gitignoreDir, "packages", "pkg-gitignore")

      await mkdirp(pkgDir)
      await writeJson(join(pkgDir, "package.json"), {
        name: "pkg-gitignore",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(pkgDir, "index.js"), "export const x = 1\n")
      await writeFile(join(pkgDir, "debug.log"), "debug info")
      await writeFile(join(pkgDir, ".gitignore"), "*.tmp\n")
      await writeFile(join(pkgDir, "temp.tmp"), "temporary file")
      await mkdirp(join(pkgDir, "dist"))
      await writeFile(join(pkgDir, "dist", "bundle.js"), "bundled code")
    })

    afterAll(async () => {
      if (gitignoreDir && (await pathExists(gitignoreDir))) {
        await remove(gitignoreDir)
      }
    })

    it("respects root .gitignore", async () => {
      await x(cli, [ "--generate", "--debug" ], { nodeOptions: { cwd: gitignoreDir } })
      const debugPath = join(gitignoreDir, ".debug-hash")

      expect(await pathExists(debugPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-gitignore"]

      expect(pkgFiles)
        .toBeDefined()
      expect(Object.keys(pkgFiles)).not.toContain("debug.log")
      expect(Object.keys(pkgFiles)
        .some((k) => k.startsWith("dist/")))
        .toBe(false)
    })

    it("respects package-level .gitignore", async () => {
      await x(cli, [ "--generate", "--debug" ], { nodeOptions: { cwd: gitignoreDir } })
      const debugPath = join(gitignoreDir, ".debug-hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-gitignore"]

      expect(Object.keys(pkgFiles)).not.toContain("temp.tmp")
      expect(Object.keys(pkgFiles))
        .toContain("index.js")
    })
  })

  describe("empty workspace handling", () => {
    let emptyDir: string

    beforeAll(async () => {
      emptyDir = join(cwd, "empty-test")
      await mkdirp(emptyDir)
      const workspaceYaml = "packages:\n  - \"packages/*\""

      await writeFile(join(emptyDir, "pnpm-workspace.yaml"), workspaceYaml)

      const pkgDir = join(emptyDir, "packages", "pkg-empty")

      await mkdirp(pkgDir)
      await writeJson(join(pkgDir, "package.json"), {
        name: "pkg-empty",
        version: "1.0.0",
      }, { spaces: 2 })
    })

    afterAll(async () => {
      if (emptyDir && (await pathExists(emptyDir))) {
        await remove(emptyDir)
      }
    })

    it("handles packages with only package.json", async () => {
      await x(cli, ["--generate"], { nodeOptions: { cwd: emptyDir } })
      const hashPath = join(emptyDir, ".hash")

      expect(await pathExists(hashPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>

      expect(content["packages/pkg-empty"])
        .toBeDefined()
      expect(typeof content["packages/pkg-empty"])
        .toBe("string")
      expect(content["packages/pkg-empty"].length)
        .toBe(64)
    })
  })

  describe("special characters in paths", () => {
    let specialDir: string

    beforeAll(async () => {
      specialDir = join(cwd, "special-chars-test")
      await mkdirp(specialDir)
      const workspaceYaml = "packages:\n  - \"packages/*\""

      await writeFile(join(specialDir, "pnpm-workspace.yaml"), workspaceYaml)

      const pkgDir = join(specialDir, "packages", "pkg-special")

      await mkdirp(pkgDir)
      await writeJson(join(pkgDir, "package.json"), {
        name: "pkg-special",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(pkgDir, "hello-world.js"), "export const x = 1\n")
      await writeFile(join(pkgDir, "file with spaces.txt"), "content")
    })

    afterAll(async () => {
      if (specialDir && (await pathExists(specialDir))) {
        await remove(specialDir)
      }
    })

    it("handles filenames with special characters", async () => {
      await x(cli, [ "--generate", "--debug" ], { nodeOptions: { cwd: specialDir } })
      const debugPath = join(specialDir, ".debug-hash")

      expect(await pathExists(debugPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-special"]

      expect(Object.keys(pkgFiles))
        .toContain("hello-world.js")
    })

    it("handles filenames with spaces", async () => {
      await x(cli, [ "--generate", "--debug" ], { nodeOptions: { cwd: specialDir } })
      const debugPath = join(specialDir, ".debug-hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-special"]

      expect(Object.keys(pkgFiles))
        .toContain("file with spaces.txt")
    })
  })

  describe("target filtering", () => {
    let targetDir: string

    beforeAll(async () => {
      const cwdLocal = globalThis.tmpRoot

      targetDir = join(cwdLocal, "target-filter-test")
      await mkdirp(targetDir)
      const workspaceYaml = "packages:\n  - \"packages/*\""

      await writeFile(join(targetDir, "pnpm-workspace.yaml"), workspaceYaml)

      const pkgNames = [ "pkg-1", "pkg-2", "pkg-3" ]

      await Promise.all(pkgNames.map(async (pkgName) => {
        const pkgDir = join(targetDir, "packages", pkgName)

        await mkdirp(pkgDir)
        await writeJson(join(pkgDir, "package.json"), {
          name: pkgName,
          version: "1.0.0",
        }, { spaces: 2 })
        await writeFile(join(pkgDir, "index.js"), `export const ${pkgName.replace("-", "_")} = true\n`)
      }))
    })

    afterAll(async () => {
      if (targetDir && (await pathExists(targetDir))) {
        await remove(targetDir)
      }
    })

    it("generates hash only for specified target", async () => {
      await x(cli, [ "--generate", "--target=packages/pkg-2" ], { nodeOptions: { cwd: targetDir } })
      const hashPath = join(targetDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>
      const keys = Object.keys(content)

      expect(keys)
        .toHaveLength(1)
      expect(keys)
        .toContain("packages/pkg-2")
    })

    it("generates hashes for multiple specified targets", async () => {
      await remove(join(targetDir, ".hash"))
      await x(cli, [ "--generate", "--target=packages/pkg-1,packages/pkg-3" ], { nodeOptions: { cwd: targetDir } })
      const hashPath = join(targetDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>
      const keys = Object.keys(content)

      expect(keys)
        .toHaveLength(2)
      expect(keys)
        .toContain("packages/pkg-1")
      expect(keys)
        .toContain("packages/pkg-3")
      expect(keys).not.toContain("packages/pkg-2")
    })

    it("compares only specified target", async () => {
      await x(cli, ["--generate"], { nodeOptions: { cwd: targetDir } })
      await writeFile(join(targetDir, "packages", "pkg-1", "index.js"), "export const pkg_1 = false\n")
      const result = await x(cli, [ "--compare", "--target=packages/pkg-2" ], {
        nodeOptions: { cwd: targetDir },
      })

      expect(result.exitCode)
        .toBe(0)
    })
  })
})
