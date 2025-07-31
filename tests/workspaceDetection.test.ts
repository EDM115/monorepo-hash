import path from "node:path"
import os from "node:os"
import { mkdirp, mkdtemp, writeFile, writeJson, remove } from "fs-extra"
import { execa } from "execa"
import { describe, it, expect, beforeAll, afterEach } from "vitest"

const cli = "node"
let cliScript: string
let tmpRoot: string
const created: string[] = []

beforeAll(() => {
  tmpRoot = globalThis.tmpRoot
  cliScript = path.join(tmpRoot, "monorepo-hash.js")
})

afterEach(async () => {
  for (const d of created.splice(0)) {
    await remove(d)
  }
})

async function setupDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), name))
  created.push(dir)
  return dir
}

async function runGenerate(cwd: string) {
  return execa(cli, [ cliScript, "--generate" ], { cwd, reject: false })
}

describe("workspace detection", () => {
  it("detects npm workspaces", async () => {
    const dir = await setupDir("npm-")
    await writeJson(path.join(dir, "package.json"), { workspaces: [ "packages/*" ] }, { spaces: 2 })
    await writeFile(path.join(dir, "package-lock.json"), "")
    const pkg = path.join(dir, "packages", "a")
    await mkdirp(pkg)
    await writeJson(path.join(pkg, "package.json"), { name: "a", version: "0.0.0" }, { spaces: 2 })
    await writeFile(path.join(pkg, "index.js"), "")

    const result = await runGenerate(dir)

    expect(result.exitCode).toBe(0)
  })

  it("detects yarn workspaces", async () => {
    const dir = await setupDir("yarn-")
    await writeJson(path.join(dir, "package.json"), { workspaces: [ "packages/*" ] }, { spaces: 2 })
    await writeFile(path.join(dir, "yarn.lock"), "")
    const pkg = path.join(dir, "packages", "a")
    await mkdirp(pkg)
    await writeJson(path.join(pkg, "package.json"), { name: "a", version: "0.0.0" }, { spaces: 2 })
    await writeFile(path.join(pkg, "index.js"), "")

    const result = await runGenerate(dir)

    expect(result.exitCode).toBe(0)
  })

  it("detects bun workspaces", async () => {
    const dir = await setupDir("bun-")
    await writeJson(path.join(dir, "package.json"), { workspaces: [ "packages/*" ] }, { spaces: 2 })
    await writeFile(path.join(dir, "bun.lock"), "")
    const pkg = path.join(dir, "packages", "a")
    await mkdirp(pkg)
    await writeJson(path.join(pkg, "package.json"), { name: "a", version: "0.0.0" }, { spaces: 2 })
    await writeFile(path.join(pkg, "index.js"), "")

    const result = await runGenerate(dir)

    expect(result.exitCode).toBe(0)
  })

  it("detects deno workspaces", async () => {
    const dir = await setupDir("deno-")
    await writeJson(path.join(dir, "deno.json"), { workspace: [ "packages/add" ] }, { spaces: 2 })
    const pkg = path.join(dir, "packages", "add")
    await mkdirp(pkg)
    await writeJson(path.join(pkg, "package.json"), { name: "add", version: "0.0.0" }, { spaces: 2 })
    await writeFile(path.join(pkg, "index.ts"), "")

    const result = await runGenerate(dir)

    expect(result.exitCode).toBe(0)
  })
})
