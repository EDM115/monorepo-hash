import { execa } from "execa"
import {
  mkdirp,
  mkdtemp,
  remove,
  writeFile,
  writeJson,
} from "fs-extra"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("workspace detection", () => {
  const cli = "node"
  let cliScript: string
  let tmpRoot: string
  const created: string[] = []
  
  beforeAll(() => {
    tmpRoot = globalThis.tmpRoot
    cliScript = join(tmpRoot, "monorepo-hash.mjs")
  })
  
  afterEach(async () => {
    const toRemove = created.splice(0)
  
    await Promise.all(toRemove.map((d) => remove(d)))
  })
  
  async function setupDir(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), name))
  
    created.push(dir)
  
    return dir
  }

  it("detects pnpm workspaces", async () => {
    const dir = await setupDir("pnpm-")

    const workspaceYaml = `
packages:
  - "packages/add"
`
    await writeFile(
      join(dir, "pnpm-workspace.yaml"),
      `${workspaceYaml.trim()}\n`,
    )
    const pkg = join(dir, "packages", "add")

    await mkdirp(pkg)
    await writeJson(join(pkg, "package.json"), {
      name: "add", version: "0.0.0",
    }, { spaces: 2 })
    await writeFile(join(pkg, "index.ts"), "")

    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd: dir, reject: false,
    })

    expect(result.exitCode)
      .toBe(0)
  })

  it("detects npm workspaces", async () => {
    const dir = await setupDir("npm-")

    await writeJson(join(dir, "package.json"), { workspaces: ["packages/*"] }, { spaces: 2 })
    await writeFile(join(dir, "package-lock.json"), "")
    const pkg = join(dir, "packages", "a")

    await mkdirp(pkg)
    await writeJson(join(pkg, "package.json"), {
      name: "a", version: "0.0.0",
    }, { spaces: 2 })
    await writeFile(join(pkg, "index.js"), "")

    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd: dir, reject: false,
    })

    expect(result.exitCode)
      .toBe(0)
  })

  it("detects yarn workspaces", async () => {
    const dir = await setupDir("yarn-")

    await writeJson(join(dir, "package.json"), { workspaces: ["packages/*"] }, { spaces: 2 })
    await writeFile(join(dir, "yarn.lock"), "")
    const pkg = join(dir, "packages", "a")

    await mkdirp(pkg)
    await writeJson(join(pkg, "package.json"), {
      name: "a", version: "0.0.0",
    }, { spaces: 2 })
    await writeFile(join(pkg, "index.js"), "")

    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd: dir, reject: false,
    })

    expect(result.exitCode)
      .toBe(0)
  })

  it("detects bun workspaces", async () => {
    const dir = await setupDir("bun-")

    await writeJson(join(dir, "package.json"), { workspaces: ["packages/*"] }, { spaces: 2 })
    await writeFile(join(dir, "bun.lock"), "")
    const pkg = join(dir, "packages", "a")

    await mkdirp(pkg)
    await writeJson(join(pkg, "package.json"), {
      name: "a", version: "0.0.0",
    }, { spaces: 2 })
    await writeFile(join(pkg, "index.js"), "")

    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd: dir, reject: false,
    })

    expect(result.exitCode)
      .toBe(0)
  })

  it("detects deno workspaces", async () => {
    const dir = await setupDir("deno-")

    await writeJson(join(dir, "deno.json"), { workspace: ["packages/add"] }, { spaces: 2 })
    const pkg = join(dir, "packages", "add")

    await mkdirp(pkg)
    await writeJson(join(pkg, "package.json"), {
      name: "add", version: "0.0.0",
    }, { spaces: 2 })
    await writeFile(join(pkg, "index.ts"), "")

    const result = await execa(cli, [ cliScript, "--generate" ], {
      cwd: dir, reject: false,
    })

    expect(result.exitCode)
      .toBe(0)
  })
})
