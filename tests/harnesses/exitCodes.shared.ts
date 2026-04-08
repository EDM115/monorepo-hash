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

import {
  mkdirp,
  pathExists,
  remove,
  writeJson,
} from "../utils"
import type { RunCli } from "./types"

export function defineExitCodesSuite(runCli: RunCli): void {
  let cwd: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
  })

  it("returns 0 for --help", async () => {
    const result = await runCli(cwd, ["--help"])

    expect(result.exitCode)
      .toBe(0)
  })

  it("returns 0 when no mode is specified", async () => {
    const result = await runCli(cwd, [])

    expect(result.exitCode)
      .toBe(0)
  })

  it("keeps --silent for --help output", async () => {
    const result = await runCli(cwd, [ "--silent", "--help" ])

    expect(result.exitCode)
      .toBe(0)
    expect(result.stdout)
      .toBe("")
    expect(result.stderr)
      .toBe("")
  })

  it("keeps --silent for --version output", async () => {
    const result = await runCli(cwd, [ "--silent", "--version" ])

    expect(result.exitCode)
      .toBe(0)
    expect(result.stdout)
      .toBe("")
    expect(result.stderr)
      .toBe("")
  })

  it("keeps --silent for no-mode help output", async () => {
    const result = await runCli(cwd, ["--silent"])

    expect(result.exitCode)
      .toBe(0)
    expect(result.stdout)
      .toBe("")
    expect(result.stderr)
      .toBe("")
  })

  it("does not let --help bypass unknown options", async () => {
    const result = await runCli(cwd, [ "--help", "--edm115" ])

    expect(result.exitCode)
      .toBe(3)
  })

  it("does not let --version bypass unknown options", async () => {
    const result = await runCli(cwd, [ "--version", "--edm115" ])


    expect(result.exitCode)
      .toBe(3)
  })

  it("keeps silent parse errors quiet", async () => {
    const result = await runCli(cwd, [ "--silent", "--edm115" ])

    expect(result.exitCode)
      .toBe(3)
    expect(result.stderr)
      .toBe("")
  })

  it("returns 2 when both --generate and --compare are specified", async () => {
    const result = await runCli(cwd, [ "--generate", "--compare" ])

    expect(result.exitCode)
      .toBe(2)
  })

  it("returns 3 for unknown option", async () => {
    const result = await runCli(cwd, ["--edm115"])

    expect(result.exitCode)
      .toBe(3)
  })

  it("returns 4 when no workspaces can be found", async () => {
    const workspaceFilePath = join(cwd, "pnpm-workspace.yaml")
    const workspaceContent = await readFile(workspaceFilePath, "utf8")

    await remove(workspaceFilePath)
    const result = await runCli(cwd, ["--generate"])

    expect(result.exitCode)
      .toBe(4)

    await writeFile(workspaceFilePath, workspaceContent)
  })

  it("returns 5 when forcing a wrong package manager", async () => {
    const result = await runCli(cwd, [ "--generate", "--packagemanager=yarn" ])

    expect(result.exitCode)
      .toBe(5)
  })

  it("surfaces auto-detect config errors even when a wrong package manager is forced", async () => {
    const invalidDir = join(cwd, "forced-pm-autodetect-error")

    await mkdirp(invalidDir)
    await writeFile(join(invalidDir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\n")
    await writeFile(join(invalidDir, "yarn.lock"), "")
    await writeJson(join(invalidDir, "package.json"), {
      "name": "forced-pm-autodetect-error",
      "private": true,
      "workspaces": ["packages/*"],
    }, { spaces: 2 })

    try {
      const result = await runCli(invalidDir, [ "--generate", "--packagemanager=npm" ])

      expect(result.exitCode)
        .toBe(99)
      expect(result.stderr)
        .not.toContain("workspaces not found. Did you mean --packagemanager=")
      expect(result.stderr)
        .not.toContain("Specified package manager not found and no supported package manager detected")
      expect(result.stderr.length)
        .toBeGreaterThan(0)
    } finally {
      await remove(invalidDir)
    }
  })

  it("returns 4 when workspace globs resolve to no package.json files", async () => {
    const noPkgDir = join(cwd, "workspace-without-packages")

    await mkdirp(noPkgDir)
    await writeFile(join(noPkgDir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")

    try {
      const result = await runCli(noPkgDir, ["--generate"])

      expect(result.exitCode)
        .toBe(4)
    } finally {
      await remove(noPkgDir)
    }
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
      const result = await runCli(circularDir, ["--generate"], { timeout: 30000 })

      expect(result.exitCode)
        .toBe(6)
      expect(result.stderr)
        .toContain("Circular dependency detected")
    }, 30000)

    it("reports the cycle path in the error message", async () => {
      const result = await runCli(circularDir, ["--generate"])

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
    const result = await runCli(cwd, ["--generate"])

    expect(result.exitCode)
      .toBe(99)

    await writeFile(packageJsonPath, packageJsonContent)
  })
}
