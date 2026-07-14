import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
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

export function defineEdgeCasesSuite(runCli: RunCli): void {
  let cwd: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
  })

  async function setupPackageJsonWorkspace(dir: string, manifest: Record<string, unknown> = {}): Promise<void> {
    const pkgDir = join(dir, "packages", "pkg-a")

    await mkdirp(pkgDir)
    await writeJson(join(dir, "package.json"), {
      workspaces: ["packages/*"],
      ...manifest,
    }, { spaces: 2 })
    await writeJson(join(pkgDir, "package.json"), {
      name: "pkg-a",
      version: "1.0.0",
    }, { spaces: 2 })
    await writeFile(join(pkgDir, "index.js"), "export const a = 1\n")
  }

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
      await runCli(gitignoreDir, [ "--generate", "--debug" ])
      const debugPath = join(gitignoreDir, ".debug-hash")

      expect(await pathExists(debugPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-gitignore"]

      expect(pkgFiles)
        .toBeDefined()
      expect(Object.keys(pkgFiles ?? {})).not.toContain("debug.log")
      expect(Object.keys(pkgFiles ?? {})
        .some((k) => k.startsWith("dist/")))
        .toBe(false)
    })

    it("respects package-level .gitignore", async () => {
      await runCli(gitignoreDir, [ "--generate", "--debug" ])
      const debugPath = join(gitignoreDir, ".debug-hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-gitignore"]

      expect(Object.keys(pkgFiles ?? {})).not.toContain("temp.tmp")
      expect(Object.keys(pkgFiles ?? {}))
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
      await runCli(emptyDir, ["--generate"])
      const hashPath = join(emptyDir, ".hash")

      expect(await pathExists(hashPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>

      expect(content["packages/pkg-empty"])
        .toBeDefined()
      expect(typeof content["packages/pkg-empty"])
        .toBe("string")
      expect(content["packages/pkg-empty"]?.length)
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
      await runCli(specialDir, [ "--generate", "--debug" ])
      const debugPath = join(specialDir, ".debug-hash")

      expect(await pathExists(debugPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-special"]

      expect(Object.keys(pkgFiles ?? {}))
        .toContain("hello-world.js")
    })

    it("handles filenames with spaces", async () => {
      await runCli(specialDir, [ "--generate", "--debug" ])
      const debugPath = join(specialDir, ".debug-hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = debugContent["packages/pkg-special"]

      expect(Object.keys(pkgFiles ?? {}))
        .toContain("file with spaces.txt")
    })
  })

  describe("dotfiles", () => {
    let dotfilesDir: string

    beforeAll(async () => {
      dotfilesDir = join(cwd, "dotfiles-test")
      await mkdirp(dotfilesDir)
      const workspaceYaml = "packages:\n  - \"packages/*\""

      await writeFile(join(dotfilesDir, "pnpm-workspace.yaml"), workspaceYaml)

      const pkgDir = join(dotfilesDir, "packages", "pkg-dotfiles")

      await mkdirp(join(pkgDir, ".well-known"))
      await mkdirp(join(pkgDir, "dist"))
      await writeJson(join(pkgDir, "package.json"), {
        name: "pkg-dotfiles",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(pkgDir, "index.js"), "export const value = 1\n")
      await writeFile(join(pkgDir, ".env"), "MODE=test\n")
      await writeFile(join(pkgDir, ".gitignore"), "dist/\n")
      await writeFile(join(pkgDir, ".well-known", ".secret.json"), "{}\n")
      await writeFile(join(pkgDir, "dist", ".dontInclude"), "export TOKEN=0xaaaa\n")
    })

    afterAll(async () => {
      if (dotfilesDir && (await pathExists(dotfilesDir))) {
        await remove(dotfilesDir)
      }
    })

    it("includes dotfiles in workspace hashing", async () => {
      await runCli(dotfilesDir, [ "--generate", "--debug" ])
      const debugPath = join(dotfilesDir, ".debug-hash")

      expect(await pathExists(debugPath))
        .toBe(true)
      // oxlint-disable-next-line no-unsafe-type-assertion
      const debugContent = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, Record<string, string>>
      const pkgFiles = Object.keys(debugContent["packages/pkg-dotfiles"] ?? {})

      expect(pkgFiles)
        .toContain(".env")
      expect(pkgFiles)
        .toContain(".gitignore")
      expect(pkgFiles)
        .toContain(".well-known/.secret.json")
      expect(pkgFiles)
        .not.toContain("dist/.dontInclude")
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
      await runCli(targetDir, [ "--generate", "--target=packages/pkg-2" ])
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
      await runCli(targetDir, [ "--generate", "--target=packages/pkg-1,packages/pkg-3" ])
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

    it("preserves spaces in comma-separated target values", async () => {
      await remove(join(targetDir, ".hash"))
      await runCli(targetDir, [ "--generate", "--target=packages/pkg-1, packages/pkg-3" ])
      const hashPath = join(targetDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>
      const keys = Object.keys(content)

      expect(keys)
        .toHaveLength(1)
      expect(keys)
        .toContain("packages/pkg-1")
      expect(keys).not.toContain("packages/pkg-3")
    })

    it("treats empty --target value as an explicit empty target list", async () => {
      await remove(join(targetDir, ".hash"))
      const result = await runCli(targetDir, [ "--generate", "--target=" ])
      const hashPath = join(targetDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>

      expect(result.exitCode)
        .toBe(0)
      expect(Object.keys(content))
        .toHaveLength(0)
    })

    it("normalizes backslashes and trailing separators in targets", async () => {
      await remove(join(targetDir, ".hash"))
      await runCli(targetDir, [ "--generate", "--target=packages\\pkg-2\\" ])
      const hashPath = join(targetDir, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>

      expect(Object.keys(content))
        .toEqual(["packages/pkg-2"])
    })

    it("compares only specified target", async () => {
      await runCli(targetDir, ["--generate"])
      await writeFile(join(targetDir, "packages", "pkg-1", "index.js"), "export const pkg_1 = false\n")
      const result = await runCli(targetDir, [ "--compare", "--target=packages/pkg-2" ])

      expect(result.exitCode)
        .toBe(0)
    })
  })

  describe("hash correctness", () => {
    it("tracks optional workspace dependencies", async () => {
      const dir = await mkdtemp(join(tmpdir(), "monorepo-hash-optional-dependency-"))
      const appDir = join(dir, "packages", "app")
      const libDir = join(dir, "packages", "optional-lib")

      await mkdirp(appDir)
      await mkdirp(libDir)
      await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
      await writeJson(join(appDir, "package.json"), {
        name: "app",
        version: "1.0.0",
        optionalDependencies: { "optional-lib": "workspace:*" },
      }, { spaces: 2 })
      await writeFile(join(appDir, "index.js"), "export const app = true\n")
      await writeJson(join(libDir, "package.json"), {
        name: "optional-lib",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(libDir, "index.js"), "export const value = 1\n")

      try {
        await runCli(dir, ["--generate"])
        await writeFile(join(libDir, "index.js"), "export const value = 2\n")

        const result = await runCli(dir, [ "--compare", "--target=packages/app" ])

        expect(result.exitCode)
          .toBe(1)
        expect(result.stdout)
          .toContain("packages/optional-lib")
      } finally {
        await remove(dir)
      }
    })

    it("separates file paths from file contents in hash inputs", async () => {
      const firstDir = await mkdtemp(join(tmpdir(), "monorepo-hash-boundary-a-"))
      const secondDir = await mkdtemp(join(tmpdir(), "monorepo-hash-boundary-b-"))

      const setup = async (dir: string, filename: string, content: string): Promise<void> => {
        const pkgDir = join(dir, "packages", "pkg")

        await mkdirp(pkgDir)
        await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
        await writeJson(join(pkgDir, "package.json"), {
          name: "pkg",
          version: "1.0.0",
        }, { spaces: 2 })
        await writeFile(join(pkgDir, filename), content)
      }

      try {
        await setup(firstDir, "a", "bc")
        await setup(secondDir, "ab", "c")
        await runCli(firstDir, ["--generate"])
        await runCli(secondDir, ["--generate"])

        // oxlint-disable-next-line no-unsafe-type-assertion
        const firstHashes = JSON.parse(await readFile(join(firstDir, ".hash"), "utf8")) as Record<string, string>
        // oxlint-disable-next-line no-unsafe-type-assertion
        const secondHashes = JSON.parse(await readFile(join(secondDir, ".hash"), "utf8")) as Record<string, string>

        expect(firstHashes["packages/pkg"])
          .not.toBe(secondHashes["packages/pkg"])
      } finally {
        await Promise.all([ remove(firstDir), remove(secondDir) ])
      }
    })
  })

  describe("workspace detection robustness", () => {
    const packageManagerSignalCases: {
      expected: string;
      files?: Record<string, string>;
      manifest?: Record<string, unknown>;
      slug: string;
      source: string;
    }[] = [
      {
        expected: "yarn",
        manifest: { packageManager: "yarn@4.9.2" },
        slug: "package-manager-field",
        source: "packageManager",
      },
      {
        expected: "bun",
        manifest: { devEngines: { packageManager: {
          name: "bun", version: "^1.2.0",
        } } },
        slug: "dev-engines-object",
        source: "object-form devEngines.packageManager",
      },
      {
        expected: "pnpm",
        manifest: { devEngines: { packageManager: [
          { name: "unsupported" }, {
            name: "pnpm", version: "^11.0.0",
          },
        ] } },
        slug: "dev-engines-array",
        source: "array-form devEngines.packageManager",
      },
      {
        expected: "pnpm",
        files: { "pnpm-workspace.yaml": "packages:\n  - \"packages/*\"\n" },
        slug: "pnpm-workspace",
        source: "pnpm-workspace.yaml",
      },
      {
        expected: "pnpm",
        files: { "pnpm-lock.yaml": "" },
        slug: "pnpm-lock",
        source: "pnpm-lock.yaml",
      },
      {
        expected: "yarn",
        files: { "yarn.lock": "" },
        slug: "yarn-lock",
        source: "yarn.lock",
      },
      {
        expected: "yarn",
        files: { ".yarnrc.yml": "" },
        slug: "yarnrc",
        source: ".yarnrc.yml",
      },
      {
        expected: "npm",
        files: { "package-lock.json": "" },
        slug: "package-lock",
        source: "package-lock.json",
      },
      {
        expected: "bun",
        files: { "bun.lock": "" },
        slug: "bun-lock",
        source: "bun.lock",
      },
      {
        expected: "bun",
        files: { "bun.lockb": "" },
        slug: "bun-lockb",
        source: "bun.lockb",
      },
      {
        expected: "pnpm",
        files: { ".pnpmfile.cjs": "" },
        slug: "pnpmfile",
        source: ".pnpmfile.cjs",
      },
      {
        expected: "pnpm",
        files: { "pnpmfile.cjs": "" },
        slug: "legacy-pnpmfile",
        source: "pnpmfile.cjs",
      },
      {
        expected: "bun",
        files: { "bunfig.toml": "" },
        slug: "bunfig",
        source: "bunfig.toml",
      },
      {
        expected: "yarn",
        files: { "yarn.config.cjs": "" },
        slug: "yarn-config",
        source: "yarn.config.cjs",
      },
    ]

    it.each(packageManagerSignalCases)("detects $expected from $source", async ({
      expected,
      files = {},
      manifest = {},
      slug,
    }) => {
      const dir = await mkdtemp(join(tmpdir(), `monorepo-hash-package-manager-signal-${slug}-`))

      await setupPackageJsonWorkspace(dir, manifest)
      await Promise.all(Object.entries(files)
        .map(([ file, content ]) => writeFile(join(dir, file), content)))

      try {
        const result = await runCli(dir, ["--generate"])

        expect(result.exitCode)
          .toBe(0)
        expect(result.stdout)
          .toContain(`Using ${expected} workspaces from`)
      } finally {
        await remove(dir)
      }
    })

    const packageManagerPrecedenceCases: {
      expected: string;
      files: Record<string, string>;
      manifest?: Record<string, unknown>;
      precedence: string;
      slug: string;
    }[] = [
      {
        expected: "yarn",
        files: { "pnpm-workspace.yaml": "packages:\n  - \"packages/*\"\n" },
        manifest: {
          devEngines: { packageManager: { name: "bun" } },
          packageManager: "yarn@4.9.2",
        },
        precedence: "packageManager over devEngines.packageManager and pnpm-workspace.yaml",
        slug: "manifest",
      },
      {
        expected: "bun",
        files: { "pnpm-workspace.yaml": "packages:\n  - \"packages/*\"\n" },
        manifest: { devEngines: { packageManager: { name: "bun" } } },
        precedence: "devEngines.packageManager over pnpm-workspace.yaml",
        slug: "dev-engines",
      },
      {
        expected: "pnpm",
        files: {
          "pnpm-workspace.yaml": "packages:\n  - \"packages/*\"\n",
          "yarn.lock": "",
        },
        precedence: "pnpm-workspace.yaml over yarn.lock",
        slug: "pnpm-workspace",
      },
      {
        expected: "pnpm",
        files: {
          "pnpm-lock.yaml": "",
          "yarn.lock": "",
        },
        precedence: "pnpm-lock.yaml over yarn.lock",
        slug: "pnpm-lock",
      },
      {
        expected: "yarn",
        files: {
          "package-lock.json": "",
          "yarn.lock": "",
        },
        precedence: "Yarn indicators over package-lock.json",
        slug: "yarn",
      },
      {
        expected: "npm",
        files: {
          "bun.lock": "",
          "package-lock.json": "",
        },
        precedence: "package-lock.json over Bun locks",
        slug: "npm",
      },
      {
        expected: "bun",
        files: {
          ".pnpmfile.cjs": "",
          "bun.lock": "",
        },
        precedence: "Bun locks over pnpm config files",
        slug: "bun",
      },
      {
        expected: "pnpm",
        files: {
          ".pnpmfile.cjs": "",
          "bunfig.toml": "",
        },
        precedence: "pnpm config files over bunfig.toml",
        slug: "pnpmfile",
      },
      {
        expected: "bun",
        files: {
          "bunfig.toml": "",
          "yarn.config.cjs": "",
        },
        precedence: "bunfig.toml over yarn.config.cjs",
        slug: "bunfig",
      },
    ]

    it.each(packageManagerPrecedenceCases)("prefers $precedence", async ({
      expected,
      files,
      manifest = {},
      slug,
    }) => {
      const dir = await mkdtemp(join(tmpdir(), `monorepo-hash-package-manager-precedence-${slug}-`))

      await setupPackageJsonWorkspace(dir, manifest)
      await Promise.all(Object.entries(files)
        .map(([ file, content ]) => writeFile(join(dir, file), content)))

      try {
        const result = await runCli(dir, ["--generate"])

        expect(result.exitCode)
          .toBe(0)
        expect(result.stdout)
          .toContain(`Using ${expected} workspaces from`)
      } finally {
        await remove(dir)
      }
    })

    it("detects a commented deno.jsonc with trailing commas", async () => {
      const dir = await mkdtemp(join(tmpdir(), "monorepo-hash-deno-jsonc-workspace-"))
      const pkgDir = join(dir, "packages", "pkg-a")

      await mkdirp(pkgDir)
      await writeFile(join(dir, "deno.jsonc"), `{
  // Keep comment-like text inside strings intact.
  "workspace": [
    "packages/*",
  ],
  /* JSONC supports block comments too. */
  "imports": {
    "example": "https://example.com/not-a-comment/*still-a-string*/",
  },
}
`)
      await writeJson(join(pkgDir, "package.json"), {
        name: "pkg-a",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(pkgDir, "index.ts"), "export const a = 1\n")

      try {
        const result = await runCli(dir, ["--generate"])

        expect(result.exitCode)
          .toBe(0)
        expect(result.stdout)
          .toContain("Using deno workspaces from")
        expect(await pathExists(join(dir, ".hash")))
          .toBe(true)
      } finally {
        await remove(dir)
      }
    })

    it("detects object-form Deno workspace members", async () => {
      const dir = await mkdtemp(join(tmpdir(), "monorepo-hash-deno-object-workspace-"))
      const pkgDir = join(dir, "packages", "pkg-a")

      await mkdirp(pkgDir)
      await writeJson(join(dir, "deno.json"), {
        workspace: { members: ["packages/*"] },
      }, { spaces: 2 })
      await writeJson(join(pkgDir, "package.json"), {
        name: "pkg-a",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(pkgDir, "index.ts"), "export const a = 1\n")

      try {
        const result = await runCli(dir, ["--generate"])

        expect(result.exitCode)
          .toBe(0)
        expect(result.stdout)
          .toContain("Using deno workspaces from")
        expect(await pathExists(join(dir, ".hash")))
          .toBe(true)
      } finally {
        await remove(dir)
      }
    })

    it("uses the nearest Deno config regardless of extension", async () => {
      const parentDir = await mkdtemp(join(tmpdir(), "monorepo-hash-deno-nearest-"))
      const childDir = join(parentDir, "nested")
      const parentPkgDir = join(parentDir, "parent-packages", "parent-pkg")
      const childPkgDir = join(childDir, "packages", "child-pkg")

      await mkdirp(parentPkgDir)
      await mkdirp(childPkgDir)
      await writeJson(join(parentDir, "deno.json"), { workspace: ["parent-packages/*"] }, { spaces: 2 })
      await writeJson(join(parentPkgDir, "package.json"), {
        name: "parent-pkg",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(parentPkgDir, "index.ts"), "export const parent = true\n")
      await writeFile(join(childDir, "deno.jsonc"), "{\n  // The nearer config must win.\n  \"workspace\": [\"packages/*\"],\n}\n")
      await writeJson(join(childPkgDir, "package.json"), {
        name: "child-pkg",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(childPkgDir, "index.ts"), "export const child = true\n")

      try {
        const result = await runCli(childDir, ["--generate"])

        expect(result.exitCode)
          .toBe(0)
        expect(await pathExists(join(childDir, ".hash")))
          .toBe(true)
        expect(await pathExists(join(parentDir, ".hash")))
          .toBe(false)
      } finally {
        await remove(parentDir)
      }
    })

    it("falls back from invalid deno.json to package.json workspaces", async () => {
      const dir = await mkdtemp(join(tmpdir(), "monorepo-hash-invalid-deno-fallback-"))

      await mkdirp(join(dir, "packages", "pkg-a"))
      await writeFile(join(dir, "deno.json"), "{ invalid json }")
      await writeJson(join(dir, "package.json"), { workspaces: ["packages/*"] }, { spaces: 2 })
      await writeJson(join(dir, "packages", "pkg-a", "package.json"), {
        name: "pkg-a",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeFile(join(dir, "packages", "pkg-a", "index.js"), "export const a = 1\n")

      try {
        const result = await runCli(dir, ["--generate"])

        expect(result.exitCode)
          .toBe(0)
        expect(result.stdout)
          .toContain("Using npm workspaces from")
      } finally {
        await remove(dir)
      }
    })

    it("returns 99 for malformed pnpm-workspace.yaml", async () => {
      const dir = join(cwd, "invalid-pnpm-workspace")

      await mkdirp(join(dir, "packages", "pkg-a"))
      await writeFile(join(dir, "pnpm-workspace.yaml"), "packages: [")
      await writeJson(join(dir, "package.json"), { workspaces: ["packages/*"] }, { spaces: 2 })
      await writeJson(join(dir, "packages", "pkg-a", "package.json"), {
        name: "pkg-a",
        version: "1.0.0",
      }, { spaces: 2 })

      try {
        const result = await runCli(dir, ["--generate"])

        expect(result.exitCode)
          .toBe(99)
      } finally {
        await remove(dir)
      }
    })

    it("supports extglob workspace patterns", async () => {
      const dir = join(cwd, "extglob-workspaces")

      await mkdirp(join(dir, "packages", "pkg-1"))
      await mkdirp(join(dir, "packages", "pkg-2"))
      await mkdirp(join(dir, "packages", "pkg-3"))
      await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/@(pkg-1|pkg-2)\"\n")

      await writeJson(join(dir, "packages", "pkg-1", "package.json"), {
        name: "pkg-1",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeJson(join(dir, "packages", "pkg-2", "package.json"), {
        name: "pkg-2",
        version: "1.0.0",
      }, { spaces: 2 })
      await writeJson(join(dir, "packages", "pkg-3", "package.json"), {
        name: "pkg-3",
        version: "1.0.0",
      }, { spaces: 2 })

      try {
        const result = await runCli(dir, ["--generate"])
        const hashPath = join(dir, ".hash")
        // oxlint-disable-next-line no-unsafe-type-assertion
        const content = JSON.parse(await readFile(hashPath, "utf8")) as Record<string, string>
        const keys = Object.keys(content)

        expect(result.exitCode)
          .toBe(0)
        expect(keys)
          .toContain("packages/pkg-1")
        expect(keys)
          .toContain("packages/pkg-2")
        expect(keys).not.toContain("packages/pkg-3")
      } finally {
        await remove(dir)
      }
    })
  })
}
