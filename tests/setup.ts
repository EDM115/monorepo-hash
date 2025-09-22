import os from "node:os"
import path from "node:path"

import {
  copyFile,
  mkdirp,
  mkdtemp,
  pathExists,
  remove,
  writeFile,
  writeJson,
} from "fs-extra"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const tmp = await mkdtemp(path.join(os.tmpdir(), "vitest-hash-"))

const workspaceYaml = `
packages:
  - "packages/*"
`

await writeFile(
  path.join(tmp, "pnpm-workspace.yaml"),
  `${workspaceYaml.trim()}\n`,
)

const pkgADir = path.join(tmp, "packages", "pkg-a")
const pkgBDir = path.join(tmp, "packages", "pkg-b")
const pkgCDir = path.join(tmp, "packages", "pkg-c")

await mkdirp(pkgADir)
await mkdirp(pkgBDir)
await mkdirp(pkgCDir)

await writeJson(
  path.join(pkgADir, "package.json"),
  {
    name: "pkg-a",
    version: "0.1.0",
    type: "module",
    dependencies: { "pkg-b": "workspace:^" },
  },
  { spaces: 2 },
)
await writeFile(
  path.join(pkgADir, "index.js"),
  "console.log(\"hello from pkg-a\")\n",
)

await writeJson(
  path.join(pkgBDir, "package.json"),
  {
    name: "pkg-b", version: "0.1.0", type: "module",
  },
  { spaces: 2 },
)
await writeFile(
  path.join(pkgBDir, "index.js"),
  "export const msg = \"pkg-b\"\n",
)

await writeJson(
  path.join(pkgCDir, "package.json"),
  {
    name: "pkg-c", version: "0.1.0", type: "module",
  },
  { spaces: 2 },
)
await writeFile(
  path.join(pkgCDir, "index.js"),
  "export const msg = \"pkg-c\"\n",
)

const src = path.resolve(__dirname, "../dist/monorepo-hash.js")

if (!(await pathExists(src))) {
  throw new Error(`monorepo-hash.js not found at ${src}`)
}

await copyFile(src, path.join(tmp, "monorepo-hash.js"))

globalThis.tmpRoot = tmp

afterAll(async () => {
  if (tmp && (await pathExists(tmp))) {
    await remove(tmp)
  }
})
