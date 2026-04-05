import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises"
import {
  dirname,
  join,
} from "node:path"
import { fileURLToPath } from "node:url"
import {
  afterAll,
  beforeAll,
  expect,
  it,
} from "vitest"

import { remove } from "../utils"
import type {
  RunCli,
  MatrixCase,
  SnapshotResult,
} from "./types"

function matrixCaseTitle(name: string): string {
  const titles: Record<string, string> = {
    "no-args": "prints help text when no arguments are provided",
    "help": "prints help text with --help",
    "unknown": "returns unknown option error for unsupported flags",
    "mode-conflict": "rejects conflicting --generate and --compare flags",
    "pm-invalid-empty": "rejects empty --packagemanager value",
    "pm-invalid-value": "rejects unsupported --packagemanager value",
    "pm-wrong-existing": "suggests detected package manager when forced one is missing",
    "generate": "generates unified root hash file for all workspaces",
    "generate-workspaces": "generates per-workspace hash files with --workspaces",
    "generate-debug": "generates unified debug hashes with --debug",
    "generate-debug-workspaces": "generates per-workspace debug hashes with --debug --workspaces",
    "generate-silent": "suppresses output while still generating hashes with --silent",
    "generate-nopathcache": "generates hashes with path cache disabled via --nopathcache",
    "generate-force-pnpm": "generates hashes when package manager is explicitly forced",
    "generate-target-one": "generates hash for a single target workspace",
    "generate-target-two": "generates hashes for multiple comma-separated targets",
    "generate-target-two-spaced": "treats spaced comma-separated targets with current parser behavior",
    "generate-target-empty": "handles empty --target value during generation",
    "compare": "reports unchanged unified hashes after baseline generation",
    "compare-workspaces": "reports unchanged per-workspace hashes after baseline generation",
    "compare-debug": "reports unchanged unified hashes in debug comparison mode",
    "compare-debug-workspaces": "reports unchanged per-workspace hashes in debug comparison mode",
    "compare-target-one": "compares a single target workspace",
    "compare-target-two": "compares multiple comma-separated target workspaces",
    "compare-target-two-spaced": "compares spaced comma-separated targets with current parser behavior",
    "compare-target-empty": "handles empty --target value during comparison",
    "compare-silent": "suppresses output while comparing hashes with --silent",
    "compare-nopathcache": "compares hashes with path cache disabled via --nopathcache",
    "u-compare": "detects changed workspace in unified compare mode",
    "u-compare-debug-no-baseline-debug": "detects changed workspace in unified debug compare without baseline debug map",
    "u-compare-target-changed": "returns changed status when targeted workspace has drift in unified mode",
    "u-compare-target-unchanged": "returns unchanged status when targeted workspace has no drift in unified mode",
    "u-compare-target-mixed": "reports mixed changed and unchanged targeted workspaces in unified mode",
    "u-compare-target-mixed-spaced": "applies current parser behavior for spaced mixed targets in unified mode",
    "u-compare-silent": "returns changed exit code without output in unified silent compare mode",
    "u-compare-nopathcache": "detects unified drift with path cache disabled",
    "u-compare-debug": "reports unified debug drift with per-file divergence output",
    "u-compare-debug-target-changed": "reports unified debug drift for changed targeted workspace",
    "u-compare-debug-target-unchanged": "reports unified debug unchanged status for unchanged targeted workspace",
    "w-compare": "detects changed workspace in per-workspace compare mode",
    "w-compare-target-changed": "returns changed status for changed targeted workspace in per-workspace mode",
    "w-compare-target-unchanged": "returns unchanged status for unchanged targeted workspace in per-workspace mode",
    "w-compare-debug": "reports per-workspace debug drift with per-file divergence output",
    "w-compare-debug-target-changed": "reports per-workspace debug drift for changed targeted workspace",
    "w-compare-debug-target-unchanged": "reports per-workspace debug unchanged status for unchanged targeted workspace",
    "drift-hash-ordering": "preserves deterministic root hash key ordering when updating existing root hash",
    "drift-glob-brace": "resolves brace globs as expected during generation",
    "drift-glob-extglob": "resolves extglob patterns as expected during generation",
    "drift-glob-negation": "applies negated workspace globs as expected during generation",
  }

  return `${titles[name] ?? "matches Node parity snapshot behavior"} [${name}]`
}

function normalizeNewlines(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function normalizeForParity(value: string): string {
  const normalized = normalizeNewlines(value)

  return normalized
    .replace(/^🔄 Computing hashes[^\n]*\n/gm, "")
    .replace(/^✅ Computed all hashes \([^\n]*\n/gm, "")
}

function maskRepoPath(value: string, repoDir: string): string {
  return value.split(repoDir)
    .join("<REPO>")
}

async function collectHashArtifacts(repoDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}

  async function walk(current: string, relPrefix: string): Promise<void> {
    const entries = await readdir(current, {
      withFileTypes: true,
    })

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relPrefix
        ? `${relPrefix}/${entry.name}`
        : entry.name

      if (entry.isDirectory()) {
        // oxlint-disable-next-line no-await-in-loop
        await walk(full, rel)

        continue
      }

      if (entry.name === ".hash" || entry.name === ".debug-hash") {
        // oxlint-disable-next-line no-await-in-loop
        out[rel] = normalizeNewlines(await readFile(full, "utf8"))
      }
    }
  }

  await walk(repoDir, "")

  return out
}

function replaceTargetPlaceholders(args: string[]): string[] {
  return args.map((arg) => arg
    .replaceAll("{T1}", "packages/a")
    .replaceAll("{T2}", "packages/b"))
}

async function writePackage(repoDir: string, rel: string, name: string, content: string): Promise<void> {
  const dir = join(repoDir, ...rel.split("/"))

  await mkdir(dir, {
    recursive: true,
  })
  await writeFile(join(dir, "package.json"), `${JSON.stringify({
    name,
    version: "1.0.0",
    type: "module",
  }, null, 2)}\n`)
  await writeFile(join(dir, "index.js"), `${content}\n`)
}

async function seedBaseRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, {
    recursive: true,
  })
  await writeFile(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")

  await writePackage(repoDir, "packages/a", "a", "export const a = true")
  await writePackage(repoDir, "packages/b", "b", "export const b = true")
  await writePackage(repoDir, "packages/c", "c", "export const c = true")
  await writePackage(repoDir, "packages/lint-config", "lint-config", "export const lintConfig = true")
  await writePackage(repoDir, "packages/types", "types", "export const types = true")
}

export function defineParityScriptMatrixSnapshotSuite(
  runtimeName: "node" | "bun" | "go",
  runCli: RunCli,
): void {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const snapshotDir = join(__dirname, "__snapshots__", "parity-matrix.node")

  let suiteRoot = ""
  let repoCounter = 0

  beforeAll(async () => {
    suiteRoot = join(globalThis.tmpRoot, `parity-script-matrix-${runtimeName}`)
    await remove(suiteRoot)
    await mkdir(suiteRoot, {
      recursive: true,
    })
    await mkdir(snapshotDir, {
      recursive: true,
    })
  })

  afterAll(async () => {
    if (suiteRoot) {
      await remove(suiteRoot)
    }
  })

  async function freshRepo(caseName: string): Promise<string> {
    repoCounter += 1
    const repoDir = join(suiteRoot, `${String(repoCounter)
      .padStart(3, "0")}-${caseName.replace(/[^a-zA-Z0-9_-]/g, "_")}`)

    await seedBaseRepo(repoDir)

    return repoDir
  }

  async function runCase(caseDef: MatrixCase): Promise<SnapshotResult> {
    const repoDir = await freshRepo(caseDef.name)
    const pre = replaceTargetPlaceholders(caseDef.pre ?? [])
    const run = replaceTargetPlaceholders(caseDef.run)

    if (pre.length > 0) {
      const preResult = await runCli(repoDir, pre)

      if (preResult.exitCode !== 0) {
        throw new Error(`Pre command failed for ${caseDef.name} : ${preResult.exitCode}\n${preResult.stdout}\n${preResult.stderr}`)
      }
    }

    if (caseDef.mutate) {
      await caseDef.mutate(repoDir, caseDef.name)
    }

    const result = await runCli(repoDir, run)
    const stdout = maskRepoPath(normalizeNewlines(result.stdout), repoDir)
    const stderr = maskRepoPath(normalizeNewlines(result.stderr), repoDir)
    const exitCode = result.exitCode ?? 0

    return {
      args: run,
      pre,
      exitCode,
      stdout,
      stderr,
      stdoutNorm: normalizeForParity(stdout),
      files: await collectHashArtifacts(repoDir),
    }
  }

  const matrixCases: MatrixCase[] = [
    {
      name: "no-args",
      run: [],
    },
    {
      name: "help",
      run: ["--help"],
    },
    {
      name: "unknown",
      run: ["--edm115"],
    },
    {
      name: "mode-conflict",
      run: [ "--generate", "--compare" ],
    },
    {
      name: "pm-invalid-empty",
      run: [ "--generate", "--packagemanager=" ],
    },
    {
      name: "pm-invalid-value",
      run: [ "--generate", "--packagemanager=edm" ],
    },
    {
      name: "pm-wrong-existing",
      run: [ "--generate", "--packagemanager=yarn" ],
    },
    {
      name: "generate",
      run: ["--generate"],
    },
    {
      name: "generate-workspaces",
      run: [ "--generate", "--workspaces" ],
    },
    {
      name: "generate-debug",
      run: [ "--generate", "--debug" ],
    },
    {
      name: "generate-debug-workspaces",
      run: [ "--generate", "--debug", "--workspaces" ],
    },
    {
      name: "generate-silent",
      run: [ "--generate", "--silent" ],
    },
    {
      name: "generate-nopathcache",
      run: [ "--generate", "--nopathcache" ],
    },
    {
      name: "generate-force-pnpm",
      run: [ "--generate", "--packagemanager=pnpm" ],
    },
    {
      name: "generate-target-one",
      run: [ "--generate", "--target={T1}" ],
    },
    {
      name: "generate-target-two",
      run: [ "--generate", "--target={T1},{T2}" ],
    },
    {
      name: "generate-target-two-spaced",
      run: [ "--generate", "--target={T1}, {T2}" ],
    },
    {
      name: "generate-target-empty",
      run: [ "--generate", "--target=" ],
    },
    {
      name: "compare",
      pre: ["--generate"],
      run: ["--compare"],
    },
    {
      name: "compare-workspaces",
      pre: [ "--generate", "--workspaces" ],
      run: [ "--compare", "--workspaces" ],
    },
    {
      name: "compare-debug",
      pre: [ "--generate", "--debug" ],
      run: [ "--compare", "--debug" ],
    },
    {
      name: "compare-debug-workspaces",
      pre: [ "--generate", "--debug", "--workspaces" ],
      run: [ "--compare", "--debug", "--workspaces" ],
    },
    {
      name: "compare-target-one",
      pre: ["--generate"],
      run: [ "--compare", "--target={T1}" ],
    },
    {
      name: "compare-target-two",
      pre: ["--generate"],
      run: [ "--compare", "--target={T1},{T2}" ],
    },
    {
      name: "compare-target-two-spaced",
      pre: ["--generate"],
      run: [ "--compare", "--target={T1}, {T2}" ],
    },
    {
      name: "compare-target-empty",
      pre: ["--generate"],
      run: [ "--compare", "--target=" ],
    },
    {
      name: "compare-silent",
      pre: ["--generate"],
      run: [ "--compare", "--silent" ],
    },
    {
      name: "compare-nopathcache",
      pre: ["--generate"],
      run: [ "--compare", "--nopathcache" ],
    },
    {
      name: "u-compare",
      pre: [ "--generate", "--silent" ],
      run: ["--compare"],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-debug-no-baseline-debug",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--debug" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-target-changed",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--target=packages/lint-config" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-target-unchanged",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--target=packages/types" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-target-mixed",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--target=packages/lint-config,packages/types" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-target-mixed-spaced",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--target=packages/lint-config, packages/types" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-silent",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--silent" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-nopathcache",
      pre: [ "--generate", "--silent" ],
      run: [ "--compare", "--nopathcache" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-debug",
      pre: [ "--generate", "--debug", "--silent" ],
      run: [ "--compare", "--debug" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-debug-target-changed",
      pre: [ "--generate", "--debug", "--silent" ],
      run: [ "--compare", "--debug", "--target=packages/lint-config" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "u-compare-debug-target-unchanged",
      pre: [ "--generate", "--debug", "--silent" ],
      run: [ "--compare", "--debug", "--target=packages/types" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "w-compare",
      pre: [ "--generate", "--workspaces", "--silent" ],
      run: [ "--compare", "--workspaces" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "w-compare-target-changed",
      pre: [ "--generate", "--workspaces", "--silent" ],
      run: [ "--compare", "--workspaces", "--target=packages/lint-config" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "w-compare-target-unchanged",
      pre: [ "--generate", "--workspaces", "--silent" ],
      run: [ "--compare", "--workspaces", "--target=packages/types" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "w-compare-debug",
      pre: [ "--generate", "--workspaces", "--debug", "--silent" ],
      run: [ "--compare", "--workspaces", "--debug" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "w-compare-debug-target-changed",
      pre: [ "--generate", "--workspaces", "--debug", "--silent" ],
      run: [ "--compare", "--workspaces", "--debug", "--target=packages/lint-config" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "w-compare-debug-target-unchanged",
      pre: [ "--generate", "--workspaces", "--debug", "--silent" ],
      run: [ "--compare", "--workspaces", "--debug", "--target=packages/types" ],
      mutate: async (repoDir, caseName) => {
        await writeFile(join(repoDir, "packages", "lint-config", "__parity-playground-change__.txt"), `playground-parity-change ${caseName}\n`)
      },
    },
    {
      name: "drift-hash-ordering",
      run: [ "--generate", "--target=packages/a", "--silent" ],
      mutate: async (repoDir) => {
        await writeFile(join(repoDir, ".hash"), `{
  "zzz/legacy": "111",
  "packages/b": "222",
  "packages/a": "333"
}\n`)
      },
    },
    {
      name: "drift-glob-brace",
      run: [ "--generate", "--silent" ],
      mutate: async (repoDir) => {
        await writeFile(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/{a,b}\"\n")
      },
    },
    {
      name: "drift-glob-extglob",
      run: [ "--generate", "--silent" ],
      mutate: async (repoDir) => {
        await writeFile(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/@(a|b)\"\n")
      },
    },
    {
      name: "drift-glob-negation",
      run: [ "--generate", "--silent" ],
      mutate: async (repoDir) => {
        await writeFile(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n  - \"!packages/b\"\n")
      },
    },
  ]

  for (const matrixCase of matrixCases) {
    it(matrixCaseTitle(matrixCase.name), async () => {
      const snapshotPath = join(snapshotDir, `${matrixCase.name}.json`)

      if (runtimeName !== "node") {
        try {
          await access(snapshotPath)
        } catch {
          throw new Error(`Node parity snapshot missing for case ${matrixCase.name} at ${snapshotPath}. Run Node matrix test with -u first.`)
        }
      }

      const result = await runCase(matrixCase)
      const snapshot: SnapshotResult = {
        args: result.args,
        pre: result.pre,
        exitCode: result.exitCode,
        stdout: result.stdoutNorm,
        stderr: result.stderr,
        stdoutNorm: result.stdoutNorm,
        files: result.files,
      }
      const serialized = `${JSON.stringify(snapshot, null, 2)}\n`

      await expect(serialized)
        .toMatchFileSnapshot(snapshotPath)
    }, 30000)
  }
}
