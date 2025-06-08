import path from "node:path"

import {
  readFile,
  remove,
  writeFile,
} from "fs-extra"
import { execa } from "execa"
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("monorepo-hash output", () => {
  let cliScript: string
  let cwd: string
  const cli = "node"

  beforeAll(() => {
    cwd = globalThis.tmpRoot
    cliScript = path.join(cwd, "monorepo-hash.js")
  })

  it("reports unchanged when no files changed, and exit code 0", async () => {
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const result = await execa(cli, [ cliScript, "--compare" ], { cwd, reject: false, all: true })

    expect(result.exitCode).toBe(0)
    expect(result.all).toContain("✅ Unchanged (2) :")
    expect(result.all).toContain("• packages/pkg-a")
    expect(result.all).toContain("• packages/pkg-b")
  })

  it("detects a file change and exits with non-zero, listing the changed workspace", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const pkgBIndex = path.join(globalThis.tmpRoot, "packages", "pkg-b", "index.js")

    await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")
    const result = await execa(cli, [ cliScript, "--compare" ], { cwd, reject: false, all: true })

    expect(result.exitCode).toBe(1)
    expect(result.all).toContain("⚠️  Changed (2) :")
    expect(result.all).toContain("• packages/pkg-b")
    expect(result.all).toContain("• packages/pkg-a")
    expect(result.all).toMatch(/changed dependency/)
  })

  it("reports missing .hash if you delete a hash file and run --compare", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const hashAPath = path.join(globalThis.tmpRoot, "packages", "pkg-a", ".hash")

    await remove(hashAPath)
    const result = await execa(cli, [ cliScript, "--compare" ], { cwd, reject: false, all: true })

    expect(result.exitCode).toBe(1)
    expect(result.all).toContain("❓ Missing .hash files (1) :")
    expect(result.all).toContain("• packages/pkg-a")
  })

  it("produces deterministic hashes across consecutive --generate runs", async () => {
    if (!globalThis.tmpRoot) {
      throw new Error("tmpRoot is not set")
    }

    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const aPath = path.join(globalThis.tmpRoot, "packages", "pkg-a", ".hash")
    const bPath = path.join(globalThis.tmpRoot, "packages", "pkg-b", ".hash")
    const firstA = (await readFile(aPath, "utf8")).trim()
    const firstB = (await readFile(bPath, "utf8")).trim()

    await remove(aPath)
    await remove(bPath)
    await execa(cli, [ cliScript, "--generate" ], { cwd })
    const secondA = (await readFile(aPath, "utf8")).trim()
    const secondB = (await readFile(bPath, "utf8")).trim()

    expect(secondA).toBe(firstA)
    expect(secondB).toBe(firstB)
  })
})
