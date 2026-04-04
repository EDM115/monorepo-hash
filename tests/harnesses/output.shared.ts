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

import { remove } from "../utils"
import type { RunCli } from "./types"

export function defineOutputSuite(runCli: RunCli): void {
  let cwd: string

  beforeAll(() => {
    cwd = globalThis.tmpRoot
  })

  describe("unified", () => {
    it("reports unchanged when no files changed, and exit code 0", async () => {
      await runCli(cwd, ["--generate"])
      const result = await runCli(cwd, ["--compare"])

      expect(result.exitCode)
        .toBe(0)

      const expectedPattern = new RegExp(
        "✅ Unchanged \\(3\\) :\\s*"
        + "• packages/pkg-a\\s*"
        + "• packages/pkg-b\\s*"
        + "• packages/pkg-c",
        "ms",
      )

      expect(result.stdout)
        .toMatch(expectedPattern)
    })

    it("detects a file change and exits with non-zero, listing the changed workspace", async () => {
      await runCli(cwd, ["--generate"])
      const pkgBIndex = join(cwd, "packages", "pkg-b", "index.js")

      await writeFile(pkgBIndex, "export const msg = \"pkg-b (edited)\"\n")
      const result = await runCli(cwd, ["--compare"])

      expect(result.exitCode)
        .toBe(1)

      const expectedPattern = new RegExp(
        "✅ Unchanged \\(1\\) :\\s*"
        + "• packages/pkg-c\\s*"
        + "⚠️  Changed \\(2\\) :\\s*"
        + "• packages/pkg-a[\\s\\S]*?"
        + "🚧 changed dependency\\(s\\) :[\\s\\S]*?"
        + "• packages/pkg-b[\\s\\S]*?"
        + "• packages/pkg-b",
        "ms",
      )

      expect(result.stdout)
        .toMatch(expectedPattern)
    })

    it("reports missing .hash if you delete an entry and run --compare", async () => {
      await runCli(cwd, ["--generate"])
      const rootHashPath = join(cwd, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
      const pkgAKey = "packages/pkg-a"

      delete content[pkgAKey]
      await writeFile(rootHashPath, `${JSON.stringify(content, null, 2)}\n`)
      const result = await runCli(cwd, ["--compare"])

      expect(result.exitCode)
        .toBe(1)
      expect(result.stdout)
        .toContain("❓ Missing .hash files (1) :")
      expect(result.stdout)
        .toContain("• packages/pkg-a")
    })

    it("treats empty old hash values as missing entries", async () => {
      await runCli(cwd, ["--generate"])
      const rootHashPath = join(cwd, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const content = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>

      content["packages/pkg-a"] = ""
      await writeFile(rootHashPath, `${JSON.stringify(content, null, 2)}\n`)

      const result = await runCli(cwd, ["--compare"])

      expect(result.exitCode)
        .toBe(1)
      expect(result.stdout)
        .toContain("❓ Missing .hash files")
      expect(result.stdout)
        .toContain("• packages/pkg-a")
    })

    it("produces deterministic hashes across consecutive --generate runs", async () => {
      await runCli(cwd, ["--generate"])
      const rootHashPath = join(cwd, ".hash")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const firstContent = JSON.parse(await readFile(rootHashPath, "utf8")) as Record<string, string>
      const pkgAKey = "packages/pkg-a"
      const pkgBKey = "packages/pkg-b"
      const firstA = firstContent[pkgAKey]
      const firstB = firstContent[pkgBKey]

      await remove(rootHashPath)
      await runCli(cwd, ["--generate"])
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
      await runCli(cwd, ["--generate", "--workspaces"])
      const hashAPath = join(cwd, "packages", "pkg-a", ".hash")

      await remove(hashAPath)
      const result = await runCli(cwd, ["--compare", "--workspaces"])

      expect(result.exitCode)
        .toBe(1)
      expect(result.stdout)
        .toContain("❓ Missing .hash files (1) :")
      expect(result.stdout)
        .toContain("• packages/pkg-a")
    })

    it("produces deterministic hashes across consecutive --generate runs", async () => {
      await runCli(cwd, ["--generate", "--workspaces"])
      const aPath = join(cwd, "packages", "pkg-a", ".hash")
      const bPath = join(cwd, "packages", "pkg-b", ".hash")
      const firstA = (await readFile(aPath, "utf8")).trim()
      const firstB = (await readFile(bPath, "utf8")).trim()

      await remove(aPath)
      await remove(bPath)
      await runCli(cwd, ["--generate", "--workspaces"])
      const secondA = (await readFile(aPath, "utf8")).trim()
      const secondB = (await readFile(bPath, "utf8")).trim()

      expect(secondA)
        .toBe(firstA)
      expect(secondB)
        .toBe(firstB)
    })
  })
}
