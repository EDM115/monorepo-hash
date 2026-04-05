import {
  readFile,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

import { x } from "../exec"
import { defineOutputSuite } from "../harnesses/output.shared"
import { remove } from "../utils"

describe("monorepo-hash CLI output", () => {
  defineOutputSuite(async (cwd, args, options?) => {
    const cliScript = join(globalThis.tmpRoot, "node", "monorepo-hash.mjs")

    return x("node", [ cliScript, ...args ], {
      nodeOptions: { cwd },
      ...options,
    })
  })
})

describe("monorepo-hash API output", () => {
  let cliScript: string
  let cliImport: string
  let cwd: string
  const cli = "node"
  const created: string[] = []

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "node", "monorepo-hash.mjs")
    cliImport = pathToFileURL(cliScript).href
  })

  afterEach(async () => {
    const toRemove = created.splice(0)

    await Promise.all(toRemove.map((d) => remove(d)))
  })

  describe("unified", () => {
    it("reports unchanged when no files changed", async () => {
      await x(cli, [ cliScript, "--generate" ], { nodeOptions: { cwd } })

      const harness = join(cwd, "unchanged.mjs")

      created.push(harness)

      await writeFile(harness, `import { runCli } from "${cliImport}"

  const result = await runCli(["--compare", "--silent"])
  console.log(JSON.stringify(result))
  `)

      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      // oxlint-disable-next-line no-unsafe-type-assertion
      const parsed = JSON.parse(stdout) as {
        unchangedTargets: string[];
        changedTargets: Array<{
          name: string; oldHash: string; newHash: string; changedDeps: string[];
        }>;
        missingTargets: Array<{
          name: string; newHash: string;
        }>
        | null;
      }

      expect(parsed).not.toBeNull()
      expect(parsed?.unchangedTargets)
        .toEqual([ "packages/pkg-a", "packages/pkg-b", "packages/pkg-c" ])
    })

    it("detects a file change and lists the changed workspace", async () => {
      await x(cli, [ cliScript, "--generate" ], { nodeOptions: { cwd } })
      const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

      await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited again)\"\n")

      const harness = join(cwd, "changed.mjs")

      created.push(harness)

      await writeFile(harness, `import { runCli } from "${cliImport}"

  const result = await runCli(["--compare", "--silent"])
  console.log(JSON.stringify(result))
  `)

      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      // oxlint-disable-next-line no-unsafe-type-assertion
      const parsed = JSON.parse(stdout) as {
        unchangedTargets: string[];
        changedTargets: Array<{
          name: string; oldHash: string; newHash: string; changedDeps: string[];
        }>;
        missingTargets: Array<{
          name: string; newHash: string;
        }>
        | null;
      }

      expect(parsed).not.toBeNull()
      expect(parsed?.unchangedTargets)
        .toEqual(["packages/pkg-c"])
      expect(parsed?.changedTargets)
        .toHaveLength(2)
      const changedNames = parsed?.changedTargets.map((t) => t.name) ?? []

      expect(changedNames)
        .toEqual([ "packages/pkg-a", "packages/pkg-b" ])
    })

    it("reports missing .hash if you delete an entry and run --compare", async () => {
      await x(cli, [ cliScript, "--generate" ], { nodeOptions: { cwd } })
      const rootHashPath = join(cwd, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
      const pkgAKey = "packages/pkg-a"

      delete content[pkgAKey]
      await writeFile(rootHashPath, `${JSON.stringify(content, null, 2)}\n`)

      const harness = join(cwd, "missing.mjs")

      created.push(harness)

      await writeFile(harness, `import { runCli } from "${cliImport}"

  const result = await runCli(["--compare", "--silent"])
  console.log(JSON.stringify(result))
  `)

      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      // oxlint-disable-next-line no-unsafe-type-assertion
      const parsed = JSON.parse(stdout) as {
        unchangedTargets: string[];
        changedTargets: Array<{
          name: string; oldHash: string; newHash: string; changedDeps: string[];
        }>;
        missingTargets: Array<{
          name: string; newHash: string;
        }>
        | null;
      }

      expect(parsed).not.toBeNull()
      expect(parsed?.missingTargets)
        .toHaveLength(1)
      expect(parsed?.missingTargets?.[0]?.name)
        .toBe("packages/pkg-a")
    })

    it("produces deterministic hashes across consecutive --generate runs", async () => {
      const harness = join(cwd, "generate.mjs")

      created.push(harness)

      await writeFile(harness, `import { runCli } from "${cliImport}"

  await runCli(["--generate", "--silent"])
  `)

      await x(cli, [harness], { nodeOptions: { cwd } })
      const rootHashPath = join(cwd, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const firstContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
      const pkgAKey = "packages/pkg-a"
      const pkgBKey = "packages/pkg-b"
      const firstA = firstContent[pkgAKey]
      const firstB = firstContent[pkgBKey]

      await remove(rootHashPath)
      await x(cli, [harness], { nodeOptions: { cwd } })
      // oxlint-disable-next-line no-unsafe-type-assertion
      const secondContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
      const secondA = secondContent[pkgAKey]
      const secondB = secondContent[pkgBKey]

      expect(secondA)
        .toBe(firstA)
      expect(secondB)
        .toBe(firstB)
    })
  })

  describe("workspaces", () => {
    it("reports missing .hash if you delete a hash file and run --compare", async () => {
      await x(cli, [ cliScript, "--generate", "--workspaces" ], { nodeOptions: { cwd } })
      const hashAPath = join(cwd, "packages", "pkg-a", ".hash")

      await remove(hashAPath)

      const harness = join(cwd, "missing.mjs")

      created.push(harness)

      await writeFile(harness, `import { runCli } from "${cliImport}"
  
  const result = await runCli(["--compare", "--silent", "--workspaces"])
  console.log(JSON.stringify(result))
  `)

      const { stdout } = await x(cli, [harness], { nodeOptions: { cwd } })

      // oxlint-disable-next-line no-unsafe-type-assertion
      const parsed = JSON.parse(stdout) as {
        unchangedTargets: string[];
        changedTargets: Array<{
          name: string; oldHash: string; newHash: string; changedDeps: string[];
        }>;
        missingTargets: Array<{
          name: string; newHash: string;
        }>
        | null;
      }

      expect(parsed).not.toBeNull()
      expect(parsed?.missingTargets)
        .toHaveLength(1)
      expect(parsed?.missingTargets?.[0]?.name)
        .toBe("packages/pkg-a")
    })

    it("produces deterministic hashes across consecutive --generate runs", async () => {
      const harness = join(cwd, "generate.mjs")

      created.push(harness)

      await writeFile(harness, `import { runCli } from "${cliImport}"
  
  await runCli(["--generate", "--silent", "--workspaces"])
  `)

      await x(cli, [harness], { nodeOptions: { cwd } })
      const aPath = join(cwd, "packages", "pkg-a", ".hash")
      const bPath = join(cwd, "packages", "pkg-b", ".hash")
      const firstA = (await readFile(aPath, "utf8")).trim()
      const firstB = (await readFile(bPath, "utf8")).trim()

      await remove(aPath)
      await remove(bPath)
      await x(cli, [harness], { nodeOptions: { cwd } })
      const secondA = (await readFile(aPath, "utf8")).trim()
      const secondB = (await readFile(bPath, "utf8")).trim()

      expect(secondA)
        .toBe(firstA)
      expect(secondB)
        .toBe(firstB)
    })
  })
})
