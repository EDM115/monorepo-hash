import { execa } from "execa"
import {
  readFile,
  remove,
  writeFile,
} from "fs-extra"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("monorepo-hash CLI output", () => {
  let cliScript: string
  let cwd: string
  const cli = "node"

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash.mjs")
  })

  it("reports unchanged when no files changed, and exit code 0", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const result = await execa(cli, [ cliScript, "--compare" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(0)

    expect(result.all)
      .toMatch(/✅ Unchanged \(3\) :/m)
    expect(result.all)
      .toMatch(new RegExp(`• packages/pkg-a`, "m"))
    expect(result.all)
      .toMatch(new RegExp(`• packages/pkg-b`, "m"))
    expect(result.all)
      .toMatch(new RegExp(`• packages/pkg-c`, "m"))
  })

  it("detects a file change and exits with non-zero, listing the changed workspace", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

    await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")
    const result = await execa(cli, [ cliScript, "--compare" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(1)

    const expectedPattern = new RegExp(
      "✅ Unchanged \\(1\\) :\\s*"
      + `• packages/pkg-c\\s*`
      + "⚠️  Changed \\(2\\) :\\s*"
      + `• packages/pkg-a[\\s\\S]*?`
      + "🚧 changed dependency\\(s\\) :[\\s\\S]*?"
      + `• packages/pkg-b[\\s\\S]*?`
      + `• packages/pkg-b`,
      "ms",
    )

    expect(result.all)
      .toMatch(expectedPattern)
  })

  it("reports missing .hash if you delete an entry and run --compare", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const rootHashPath = join(cwd, ".hash")
    // oxlint-disable-next-line no-unsafe-type-assertion
    const content = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
    const pkgAKey = "packages/pkg-a"

    delete content[pkgAKey]
    await writeFile(rootHashPath, `${JSON.stringify(content, null, 2)}\n`)
    const result = await execa(cli, [ cliScript, "--compare" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(1)
    expect(result.all)
      .toContain("❓ Missing .hash files (1) :")
    expect(result.all)
      .toContain(`• packages/pkg-a`)
  })

  it("reports missing .hash if you delete a hash file and run --compare (per workspace)", async () => {
    await execa(cli, [ cliScript, "--generate", "--workspaces" ], { cwd })
    const hashAPath = join(cwd, "packages", "pkg-a", ".hash")

    await remove(hashAPath)
    const result = await execa(cli, [ cliScript, "--compare", "--workspaces" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(1)
    expect(result.all)
      .toContain("❓ Missing .hash files (1) :")
    expect(result.all)
      .toContain(`• packages/pkg-a`)
  })

  it("produces deterministic hashes across consecutive --generate runs", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const rootHashPath = join(cwd, ".hash")
    // oxlint-disable-next-line no-unsafe-type-assertion
    const firstContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
    const pkgAKey = "packages/pkg-a"
    const pkgBKey = "packages/pkg-b"
    const firstA = firstContent[pkgAKey]
    const firstB = firstContent[pkgBKey]

    await remove(rootHashPath)
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    // oxlint-disable-next-line no-unsafe-type-assertion
    const secondContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
    const secondA = secondContent[pkgAKey]
    const secondB = secondContent[pkgBKey]

    expect(secondA)
      .toBe(firstA)
    expect(secondB)
      .toBe(firstB)
  })

  it("produces deterministic hashes across consecutive --generate runs (per workspace)", async () => {
    await execa(cli, [ cliScript, "--generate", "--workspaces" ], { cwd })
    const aPath = join(cwd, "packages", "pkg-a", ".hash")
    const bPath = join(cwd, "packages", "pkg-b", ".hash")
    const firstA = (await readFile(aPath, "utf8")).trim()
    const firstB = (await readFile(bPath, "utf8")).trim()

    await remove(aPath)
    await remove(bPath)
    await execa(cli, [ cliScript, "--generate", "--workspaces" ], { cwd })
    const secondA = (await readFile(aPath, "utf8")).trim()
    const secondB = (await readFile(bPath, "utf8")).trim()

    expect(secondA)
      .toBe(firstA)
    expect(secondB)
      .toBe(firstB)
  })
})

describe("monorepo-hash output", () => {
  let cliScript: string
  let cliImport: string
  let cwd: string
  const cli = "node"
  const created: string[] = []

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash.mjs")
    cliImport = pathToFileURL(cliScript).href
  })

  afterEach(async () => {
    const toRemove = created.splice(0)

    await Promise.all(toRemove.map((d) => remove(d)))
  })

  it("reports unchanged when no files changed", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })

    const harness = join(cwd, "unchanged.mjs")

    created.push(harness)

    await writeFile(harness, `import { runCli } from "${cliImport}"

const result = await runCli(["--compare", "--silent"])
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd })

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
      .toHaveLength(3)
    expect(parsed?.unchangedTargets)
      .toContain(`packages/pkg-a`)
    expect(parsed?.unchangedTargets)
      .toContain(`packages/pkg-b`)
    expect(parsed?.unchangedTargets)
      .toContain(`packages/pkg-c`)
  })

  it("detects a file change and lists the changed workspace", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

    await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited again)\"\n")

    const harness = join(cwd, "changed.mjs")

    created.push(harness)

    await writeFile(harness, `import { runCli } from "${cliImport}"

const result = await runCli(["--compare", "--silent"])
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd })

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
      .toHaveLength(1)
    expect(parsed?.unchangedTargets)
      .toContain(`packages/pkg-c`)
    expect(parsed?.changedTargets)
      .toHaveLength(2)
    const changedNames = parsed?.changedTargets.map((t) => t.name) ?? []

    expect(changedNames)
      .toContain(`packages/pkg-a`)
    expect(changedNames)
      .toContain(`packages/pkg-b`)
  })

  it("reports missing .hash if you delete an entry and run --compare", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
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

    const { stdout } = await execa(cli, [harness], { cwd })

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
    expect(parsed?.missingTargets?.[0].name)
      .toBe(`packages/pkg-a`)
  })

  it("reports missing .hash if you delete a hash file and run --compare (per workspace)", async () => {
    await execa(cli, [ cliScript, "--generate", "--workspaces" ], { cwd })
    const hashAPath = join(cwd, "packages", "pkg-a", ".hash")

    await remove(hashAPath)

    const harness = join(cwd, "missing.mjs")

    created.push(harness)

    await writeFile(harness, `import { runCli } from "${cliImport}"

const result = await runCli(["--compare", "--silent", "--workspaces"])
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd })

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
    expect(parsed?.missingTargets?.[0].name)
      .toBe(`packages/pkg-a`)
  })

  it("produces deterministic hashes across consecutive --generate runs", async () => {
    const harness = join(cwd, "generate.mjs")

    created.push(harness)

    await writeFile(harness, `import { runCli } from "${cliImport}"

await runCli(["--generate", "--silent"])
`)

    await execa(cli, [harness], { cwd })
    const rootHashPath = join(cwd, ".hash")
    // oxlint-disable-next-line no-unsafe-type-assertion
    const firstContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
    const pkgAKey = "packages/pkg-a"
    const pkgBKey = "packages/pkg-b"
    const firstA = firstContent[pkgAKey]
    const firstB = firstContent[pkgBKey]

    await remove(rootHashPath)
    await execa(cli, [harness], { cwd })
    // oxlint-disable-next-line no-unsafe-type-assertion
    const secondContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
    const secondA = secondContent[pkgAKey]
    const secondB = secondContent[pkgBKey]

    expect(secondA)
      .toBe(firstA)
    expect(secondB)
      .toBe(firstB)
  })

  it("produces deterministic hashes across consecutive --generate runs (per workspace)", async () => {
    const harness = join(cwd, "generate.mjs")

    created.push(harness)

    await writeFile(harness, `import { runCli } from "${cliImport}"

await runCli(["--generate", "--silent", "--workspaces"])
`)

    await execa(cli, [harness], { cwd })
    const aPath = join(cwd, "packages", "pkg-a", ".hash")
    const bPath = join(cwd, "packages", "pkg-b", ".hash")
    const firstA = (await readFile(aPath, "utf8")).trim()
    const firstB = (await readFile(bPath, "utf8")).trim()

    await remove(aPath)
    await remove(bPath)
    await execa(cli, [harness], { cwd })
    const secondA = (await readFile(aPath, "utf8")).trim()
    const secondB = (await readFile(bPath, "utf8")).trim()

    expect(secondA)
      .toBe(firstA)
    expect(secondB)
      .toBe(firstB)
  })
})
