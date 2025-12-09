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
import { pathToFileURL } from "node:url"
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest"

describe("workspace detection", () => {
  const cli = "bun"
  let cliScript: string
  let cliImport: string
  let cwd: string
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

    const harness = join(dir, "detect-pnpm.mjs")

    await writeFile(harness, `import { detectPNPM } from "${cliImport}"

const result = await detectPNPM()
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd: dir })

    // oxlint-disable-next-line no-unsafe-type-assertion
    const parsed = JSON.parse(stdout) as {
      pm: string; root: string; globs: string[];
    } | null

    expect(parsed).not.toBeNull()
    expect(parsed?.pm)
      .toBe("pnpm")
    expect(parsed?.root)
      .toBe(dir)
    expect(parsed?.globs)
      .toEqual(["packages/add"])
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

    const harness = join(dir, "detect-npm.mjs")

    await writeFile(harness, `import { detectPkgJson } from "${cliImport}"

const result = await detectPkgJson()
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd: dir })

    // oxlint-disable-next-line no-unsafe-type-assertion
    const parsed = JSON.parse(stdout) as {
      pm: string; root: string; globs: string[];
    } | null

    expect(parsed).not.toBeNull()
    expect(parsed?.pm)
      .toBe("npm")
    expect(parsed?.root)
      .toBe(dir)
    expect(parsed?.globs)
      .toEqual(["packages/*"])
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

    const harness = join(dir, "detect-yarn.mjs")

    await writeFile(harness, `import { detectPkgJson } from "${cliImport}"

const result = await detectPkgJson()
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd: dir })

    // oxlint-disable-next-line no-unsafe-type-assertion
    const parsed = JSON.parse(stdout) as {
      pm: string; root: string; globs: string[];
    } | null

    expect(parsed).not.toBeNull()
    expect(parsed?.pm)
      .toBe("yarn")
    expect(parsed?.root)
      .toBe(dir)
    expect(parsed?.globs)
      .toEqual(["packages/*"])
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

    const harness = join(dir, "detect-bun.mjs")

    await writeFile(harness, `import { detectPkgJson } from "${cliImport}"

const result = await detectPkgJson()
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd: dir })

    // oxlint-disable-next-line no-unsafe-type-assertion
    const parsed = JSON.parse(stdout) as {
      pm: string; root: string; globs: string[];
    } | null

    expect(parsed).not.toBeNull()
    expect(parsed?.pm)
      .toBe("bun")
    expect(parsed?.root)
      .toBe(dir)
    expect(parsed?.globs)
      .toEqual(["packages/*"])
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

    const harness = join(dir, "detect-deno.mjs")

    await writeFile(harness, `import { detectDeno } from "${cliImport}"

const result = await detectDeno()
console.log(JSON.stringify(result))
`)

    const { stdout } = await execa(cli, [harness], { cwd: dir })

    // oxlint-disable-next-line no-unsafe-type-assertion
    const parsed = JSON.parse(stdout) as {
      pm: string; root: string; globs: string[];
    } | null

    expect(parsed).not.toBeNull()
    expect(parsed?.pm)
      .toBe("deno")
    expect(parsed?.root)
      .toBe(dir)
    expect(parsed?.globs)
      .toEqual(["packages/add"])
  })
})
