import {
  copyFile,
  mkdirp,
  mkdtemp,
  pathExists,
  remove,
  writeFile,
  writeJson,
} from "fs-extra"
import { tmpdir } from "node:os"
import {
  dirname,
  join,
  resolve,
} from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const tmp = await mkdtemp(join(tmpdir(), "vitest-hash-"))

const workspaceYaml = `
packages:
  - "packages/*"
`

await writeFile(
  join(tmp, "pnpm-workspace.yaml"),
  `${workspaceYaml.trim()}\n`,
)

const pkgADir = join(tmp, "packages", "pkg-a")
const pkgBDir = join(tmp, "packages", "pkg-b")
const pkgCDir = join(tmp, "packages", "pkg-c")

await mkdirp(pkgADir)
await mkdirp(pkgBDir)
await mkdirp(pkgCDir)

await writeJson(
  join(pkgADir, "package.json"),
  {
    name: "pkg-a",
    version: "0.1.0",
    type: "module",
    dependencies: { "pkg-b": "workspace:*" },
  },
  { spaces: 2 },
)
await writeFile(
  join(pkgADir, "index.js"),
  "console.log(\"hello from pkg-a\")\n",
)

await writeJson(
  join(pkgBDir, "package.json"),
  {
    name: "pkg-b", version: "0.1.0", type: "module",
  },
  { spaces: 2 },
)
await writeFile(
  join(pkgBDir, "index.js"),
  "export const msg = \"pkg-b\"\n",
)

await writeJson(
  join(pkgCDir, "package.json"),
  {
    name: "pkg-c", version: "0.1.0", type: "module",
  },
  { spaces: 2 },
)
await writeFile(
  join(pkgCDir, "index.js"),
  "export const msg = \"pkg-c\"\n",
)

let src = resolve(__dirname, "../dist/monorepo-hash.mjs")

if (!(await pathExists(src))) {
  throw new Error(`monorepo-hash.mjs not found at ${src}`)
}

await copyFile(src, join(tmp, "monorepo-hash.mjs"))

src = resolve(__dirname, "../src/monorepo-hash-bun.ts")

if (!(await pathExists(src))) {
  throw new Error(`monorepo-hash-bun.ts not found at ${src}`)
}

await copyFile(src, join(tmp, "monorepo-hash-bun.ts"))

globalThis.tmpRoot = tmp

afterAll(async () => {
  if (tmp && (await pathExists(tmp))) {
    await remove(tmp)
  }
})
