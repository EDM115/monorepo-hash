import { execa } from "execa"
import {
  readFile,
  remove,
  writeFile,
} from "fs-extra"
import {
  join,
  sep,
} from "node:path"
import { pathToFileURL } from "node:url"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("monorepo-hash CLI output", () => {
  let cwd: string
  let cli: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cli = join(cwd, "monorepo-hash-linux-x64")
  })

  it("reports unchanged when no files changed, and exit code 0", async () => {
    await execa(cli, [ "--generate" ], { cwd })
    const result = await execa(cli, [ "--compare" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(0)

    expect(result.all)
      .toMatch(/✅ Unchanged \(3\) :/m)
    expect(result.all)
      .toMatch(new RegExp(`• packages${sep.replace(/\\/g, "\\\\")}pkg-a`, "m"))
    expect(result.all)
      .toMatch(new RegExp(`• packages${sep.replace(/\\/g, "\\\\")}pkg-b`, "m"))
    expect(result.all)
      .toMatch(new RegExp(`• packages${sep.replace(/\\/g, "\\\\")}pkg-c`, "m"))
  })

  it("detects a file change and exits with non-zero, listing the changed workspace", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ "--generate" ], { cwd })
    const pkgBIndex = join(globalThis.tmpRoot, "packages", "pkg-b", "index.js")

    await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")
    const result = await execa(cli, [ "--compare" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(1)

    const expectedPattern = new RegExp(
      "✅ Unchanged \\(1\\) :\\s*"
      + `• packages${sep.replace(/\\/g, "\\\\")}pkg-c\\s*`
      + "⚠️  Changed \\(2\\) :\\s*"
      + `• packages${sep.replace(/\\/g, "\\\\")}pkg-a[\\s\\S]*?`
      + "🚧 changed dependency\\(s\\) :[\\s\\S]*?"
      + `• packages${sep.replace(/\\/g, "\\\\")}pkg-b[\\s\\S]*?`
      + `• packages${sep.replace(/\\/g, "\\\\")}pkg-b`,
      "ms",
    )

    expect(result.all)
      .toMatch(expectedPattern)
  })

  it("reports missing .hash if you delete a hash file and run --compare", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ "--generate" ], { cwd })
    const hashAPath = join(globalThis.tmpRoot, "packages", "pkg-a", ".hash")

    await remove(hashAPath)
    const result = await execa(cli, [ "--compare" ], {
      cwd, reject: false, all: true,
    })

    expect(result.exitCode)
      .toBe(1)
    expect(result.all)
      .toContain("❓ Missing .hash files (1) :")
    expect(result.all)
      .toContain(`• packages${sep}pkg-a`)
  })

  it("produces deterministic hashes across consecutive --generate runs", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ "--generate" ], { cwd })
    const aPath = join(globalThis.tmpRoot, "packages", "pkg-a", ".hash")
    const bPath = join(globalThis.tmpRoot, "packages", "pkg-b", ".hash")
    const firstA = (await readFile(aPath, "utf8")).trim()
    const firstB = (await readFile(bPath, "utf8")).trim()

    await remove(aPath)
    await remove(bPath)
    await execa(cli, [ "--generate" ], { cwd })
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
  const cli = "bun"
  const created: string[] = []

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = join(cwd, "monorepo-hash-bun.ts")
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
      .toContain(`packages${sep}pkg-a`)
    expect(parsed?.unchangedTargets)
      .toContain(`packages${sep}pkg-b`)
    expect(parsed?.unchangedTargets)
      .toContain(`packages${sep}pkg-c`)
  })

  it("detects a file change and lists the changed workspace", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const pkgBIndex = join(globalThis.tmpRoot, "packages", "pkg-b", "index.js")

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
      .toContain(`packages${sep}pkg-c`)
    expect(parsed?.changedTargets)
      .toHaveLength(2)
    const changedNames = parsed?.changedTargets.map((t) => t.name) ?? []

    expect(changedNames)
      .toContain(`packages${sep}pkg-a`)
    expect(changedNames)
      .toContain(`packages${sep}pkg-b`)
  })

  it("reports missing .hash if you delete a hash file and run --compare", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const hashAPath = join(globalThis.tmpRoot, "packages", "pkg-a", ".hash")

    await remove(hashAPath)

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
      .toBe(`packages${sep}pkg-a`)
  })

  it("produces deterministic hashes across consecutive --generate runs", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    const harness = join(cwd, "generate.mjs")

    created.push(harness)

    await writeFile(harness, `import { runCli } from "${cliImport}"

await runCli(["--generate", "--silent"])
`)

    await execa(cli, [harness], { cwd })
    const aPath = join(globalThis.tmpRoot, "packages", "pkg-a", ".hash")
    const bPath = join(globalThis.tmpRoot, "packages", "pkg-b", ".hash")
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
