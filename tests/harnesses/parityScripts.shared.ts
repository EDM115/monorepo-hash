import {
  readFile,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import {
  afterAll,
  beforeAll,
  expect,
  it,
} from "vitest"

import {
  mkdirp,
  remove,
  writeJson,
} from "../utils"
import type {
  RunCli,
  ProbeCheck,
} from "./types"

function normalizeNewlines(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function workspaceYaml(patterns: string[]): string {
  return `packages:\n${patterns.map((p) => `  - "${p}"`)
    .join("\n")}\n`
}

async function readRootHashKeys(repoDir: string): Promise<string[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const content = JSON.parse(await readFile(join(repoDir, ".hash"), "utf8")) as Record<string, string>

  return Object.keys(content)
    .toSorted((a, b) => a.localeCompare(b))
}

async function addPackage(
  repoDir: string,
  relDir: string,
  packageName: string,
  options: {
    content?: string;
    manifestExtra?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const dir = join(repoDir, ...relDir.split("/"))

  await mkdirp(dir)
  await writeJson(join(dir, "package.json"), {
    name: packageName,
    version: "1.0.0",
    type: "module",
    ...options.manifestExtra,
  }, {
    spaces: 2,
  })
  await writeFile(join(dir, "index.js"), options.content ?? `export const ${packageName.replace(/[^a-zA-Z0-9_]/g, "_")} = true\n`)
}

export function defineParityScriptProbeSuite(runCli: RunCli): void {
  let suiteRoot = ""

  beforeAll(() => {
    suiteRoot = join(globalThis.tmpRoot, "parity-script-probes")
  })

  afterAll(async () => {
    if (suiteRoot) {
      await remove(suiteRoot)
    }
  })

  async function createRepo(name: string): Promise<string> {
    const repoDir = join(suiteRoot, name)

    await remove(repoDir)
    await mkdirp(repoDir)

    return repoDir
  }

  it("covers parser/flag matrix probes from parity scripts", async () => {
    const repoDir = await createRepo("flags-matrix")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await addPackage(repoDir, "packages/a", "a")

    const checks: ProbeCheck[] = [
      {
        name: "no-args",
        args: [],
        exitCode: 0,
        stdoutIncludes: [ "monorepo-hash by EDM115", "Arguments :" ],
      },
      {
        name: "help",
        args: ["--help"],
        exitCode: 0,
        stdoutIncludes: [ "monorepo-hash by EDM115", "Arguments :" ],
      },
      {
        name: "version",
        args: ["--version"],
        exitCode: 0,
        stdoutRegex: /^monorepo-hash v3\.0\.0\n$/,
      },
      {
        name: "unknown",
        args: ["--edm115"],
        exitCode: 3,
        stderrIncludes: ["Unknown option : --edm115"],
      },
      {
        name: "mode-conflict",
        args: [ "--generate", "--compare" ],
        exitCode: 2,
        stderrIncludes: ["Cannot specify both --generate and --compare"],
      },
      {
        name: "pm-invalid-empty",
        args: [ "--generate", "--packagemanager=" ],
        exitCode: 2,
        stderrIncludes: ["Invalid package manager"],
      },
      {
        name: "pm-invalid-value",
        args: [ "--generate", "--packagemanager=edm" ],
        exitCode: 2,
        stderrIncludes: ["Invalid package manager"],
      },
      {
        name: "pm-wrong-existing",
        args: [ "--generate", "--packagemanager=yarn" ],
        exitCode: 5,
        stderrIncludes: ["workspaces not found"],
      },
      {
        name: "silent-help",
        args: [ "--silent", "--help" ],
        exitCode: 0,
        stdoutExact: "",
        stderrExact: "",
      },
      {
        name: "silent-version",
        args: [ "--silent", "--version" ],
        exitCode: 0,
        stdoutExact: "",
        stderrExact: "",
      },
      {
        name: "help-unknown",
        args: [ "--help", "--edm115" ],
        exitCode: 3,
        stderrIncludes: ["Unknown option : --edm115"],
      },
      {
        name: "version-unknown",
        args: [ "--version", "--edm115" ],
        exitCode: 3,
        stderrIncludes: ["Unknown option : --edm115"],
      },
      {
        name: "version-generate",
        args: [ "--version", "--generate" ],
        exitCode: 0,
        stdoutRegex: /^monorepo-hash v3\.0\.0\n$/,
      },
    ]

    for (const check of checks) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await runCli(repoDir, check.args)
      const stdout = normalizeNewlines(result.stdout)
      const stderr = normalizeNewlines(result.stderr)

      expect(result.exitCode, `exit mismatch for ${check.name}`)
        .toBe(check.exitCode)

      if (check.stdoutExact !== undefined) {
        expect(stdout, `stdout mismatch for ${check.name}`)
          .toBe(check.stdoutExact)
      }

      if (check.stderrExact !== undefined) {
        expect(stderr, `stderr mismatch for ${check.name}`)
          .toBe(check.stderrExact)
      }

      if (check.stdoutRegex !== undefined) {
        expect(stdout, `stdout format mismatch for ${check.name}`)
          .toMatch(check.stdoutRegex)
      }

      if (check.stdoutIncludes !== undefined) {
        for (const needle of check.stdoutIncludes) {
          expect(stdout, `stdout missing ${needle} for ${check.name}`)
            .toContain(needle)
        }
      }

      if (check.stderrIncludes !== undefined) {
        for (const needle of check.stderrIncludes) {
          expect(stderr, `stderr missing ${needle} for ${check.name}`)
            .toContain(needle)
        }
      }

      if (check.name === "version-generate") {
        expect(stdout)
          .not.toContain("Generating hashes")
      }
    }
  }, 30000)

  it("covers workspace-without-packagejson probe", async () => {
    const repoDir = await createRepo("workspace-no-packagejson")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))

    const result = await runCli(repoDir, ["--generate"])

    expect(result.exitCode)
      .toBe(4)
    expect(normalizeNewlines(result.stderr))
      .toContain("No package.json files found in workspaces")
  })

  it("covers malformed package.json probe", async () => {
    const repoDir = await createRepo("workspace-invalid-package-json")

    await mkdirp(join(repoDir, "packages", "a"))
    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await writeFile(join(repoDir, "packages", "a", "package.json"), "{ invalid json }")

    const result = await runCli(repoDir, ["--generate"])

    expect(result.exitCode)
      .toBe(99)
    expect(normalizeNewlines(result.stderr))
      .toContain("❌")
  })

  it("covers missing package name probe", async () => {
    const repoDir = await createRepo("workspace-missing-package-name")

    await mkdirp(join(repoDir, "packages", "a"))
    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await writeFile(join(repoDir, "packages", "a", "package.json"), "{\"version\":\"1.0.0\"}")
    await writeFile(join(repoDir, "packages", "a", "index.js"), "export const x = 1\n")

    const result = await runCli(repoDir, ["--generate"])

    expect(result.exitCode)
      .toBe(99)
    expect(normalizeNewlines(result.stderr))
      .toContain("❌")
  })

  it("covers compare-empty-oldhash probe", async () => {
    const repoDir = await createRepo("compare-empty-oldhash")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await addPackage(repoDir, "packages/a", "a")

    const generate = await runCli(repoDir, [ "--generate", "--silent" ])

    expect(generate.exitCode)
      .toBe(0)

    await writeJson(join(repoDir, ".hash"), {
      "packages/a": "",
    }, {
      spaces: 2,
    })

    const compare = await runCli(repoDir, ["--compare"])
    const stdout = normalizeNewlines(compare.stdout)

    expect(compare.exitCode)
      .toBe(1)
    expect(stdout)
      .toContain("❓ Missing .hash files (1) :")
    expect(stdout)
      .toContain("• packages/a")
  })

  it("covers target spacing and empty target probes", async () => {
    const repoDir = await createRepo("target-spacing")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await addPackage(repoDir, "packages/a", "a")
    await addPackage(repoDir, "packages/b", "b")

    const first = await runCli(repoDir, [ "--generate", "--target=packages/a,packages/b", "--silent" ])

    expect(first.exitCode)
      .toBe(0)
    expect(await readRootHashKeys(repoDir))
      .toEqual([ "packages/a", "packages/b" ])

    await remove(join(repoDir, ".hash"))

    const spaced = await runCli(repoDir, [ "--generate", "--target=packages/a, packages/b", "--silent" ])

    expect(spaced.exitCode)
      .toBe(0)
    expect(await readRootHashKeys(repoDir))
      .toEqual(["packages/a"])

    await remove(join(repoDir, ".hash"))

    const empty = await runCli(repoDir, [ "--generate", "--target=", "--silent" ])

    expect(empty.exitCode)
      .toBe(0)
    expect(await readRootHashKeys(repoDir))
      .toEqual([])
  })

  it("covers root .hash ordering seed probe", async () => {
    const repoDir = await createRepo("hash-ordering")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await addPackage(repoDir, "packages/a", "a", { content: "a\n" })
    await addPackage(repoDir, "packages/b", "b", { content: "b\n" })

    const seedHash = [
      "{",
      "  \"zzz/legacy\": \"111\",",
      "  \"packages/b\": \"222\",",
      "  \"packages/a\": \"333\"",
      "}",
      "",
    ].join("\n")

    await writeFile(join(repoDir, ".hash"), seedHash)

    const generated = await runCli(repoDir, [ "--generate", "--target=packages/a", "--silent" ])

    expect(generated.exitCode)
      .toBe(0)

    const raw = await readFile(join(repoDir, ".hash"), "utf8")
    const indexA = raw.indexOf("\"packages/a\"")
    const indexB = raw.indexOf("\"packages/b\"")
    const indexLegacy = raw.indexOf("\"zzz/legacy\"")

    expect(indexA)
      .toBeGreaterThanOrEqual(0)
    expect(indexB)
      .toBeGreaterThan(indexA)
    expect(indexLegacy)
      .toBeGreaterThan(indexB)
  })

  it("covers compare --debug without baseline debug probe", async () => {
    const repoDir = await createRepo("compare-debug-no-baseline")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await addPackage(repoDir, "packages/a", "a")
    await addPackage(repoDir, "packages/b", "b")

    const generated = await runCli(repoDir, [ "--generate", "--silent" ])

    expect(generated.exitCode)
      .toBe(0)

    const changedPath = join(repoDir, "packages", "a", "index.js")

    await writeFile(changedPath, "export const a = false\n")

    const compared = await runCli(repoDir, [ "--compare", "--debug" ])

    expect(compared.exitCode)
      .toBe(1)
    expect(normalizeNewlines(compared.stdout))
      .not.toContain("has no .debug-hash to compare")
  })

  it("covers changed-compare target matrix probes", async () => {
    const repoDir = await createRepo("changed-compare-matrix")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/*"]))
    await addPackage(repoDir, "packages/lint-config", "lint-config")
    await addPackage(repoDir, "packages/types", "types")

    const generated = await runCli(repoDir, [ "--generate", "--silent" ])

    expect(generated.exitCode)
      .toBe(0)

    await writeFile(join(repoDir, "packages", "lint-config", "index.js"), "export const lint_config = false\n")

    const changedOnly = await runCli(repoDir, [ "--compare", "--target=packages/lint-config" ])
    const unchangedOnly = await runCli(repoDir, [ "--compare", "--target=packages/types" ])
    const mixed = await runCli(repoDir, [ "--compare", "--target=packages/lint-config,packages/types" ])
    const mixedSpaced = await runCli(repoDir, [ "--compare", "--target=packages/lint-config, packages/types" ])

    expect(changedOnly.exitCode)
      .toBe(1)
    expect(unchangedOnly.exitCode)
      .toBe(0)
    expect(mixed.exitCode)
      .toBe(1)
    expect(mixedSpaced.exitCode)
      .toBe(1)

    expect(normalizeNewlines(mixedSpaced.stdout))
      .not.toContain("• packages/types")
  })

  it("covers brace-glob workspace probe", async () => {
    const repoDir = await createRepo("glob-brace")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/{a,b}"]))
    await addPackage(repoDir, "packages/a", "a")
    await addPackage(repoDir, "packages/b", "b")
    await addPackage(repoDir, "packages/c", "c")

    const generated = await runCli(repoDir, [ "--generate", "--silent" ])

    expect(generated.exitCode)
      .toBe(0)
    expect(await readRootHashKeys(repoDir))
      .toEqual([ "packages/a", "packages/b" ])
  })

  it("covers extglob workspace probe", async () => {
    const repoDir = await createRepo("glob-extglob")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml(["packages/@(a|b)"]))
    await addPackage(repoDir, "packages/a", "a")
    await addPackage(repoDir, "packages/b", "b")
    await addPackage(repoDir, "packages/c", "c")

    const generated = await runCli(repoDir, [ "--generate", "--silent" ])

    expect(generated.exitCode)
      .toBe(0)
    expect(await readRootHashKeys(repoDir))
      .toEqual([ "packages/a", "packages/b" ])
  })

  it("covers negated workspace glob probe", async () => {
    const repoDir = await createRepo("glob-negation")

    await writeFile(join(repoDir, "pnpm-workspace.yaml"), workspaceYaml([ "packages/*", "!packages/b" ]))
    await addPackage(repoDir, "packages/a", "a")
    await addPackage(repoDir, "packages/b", "b")
    await addPackage(repoDir, "packages/c", "c")

    const generated = await runCli(repoDir, [ "--generate", "--silent" ])

    expect(generated.exitCode)
      .toBe(0)
    expect(await readRootHashKeys(repoDir))
      .toEqual([ "packages/a", "packages/c" ])
  })
}
