import {
  createWriteStream,
  chmodSync,
} from "node:fs"
import {
  mkdir,
  readFile,
  unlink,
} from "node:fs/promises"
import { get } from "node:https"
import {
  dirname,
  join,
} from "node:path"
import { env } from "node:process"
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url"

import {
  detectPlatformId,
  getBinaryBasename,
} from "./platform"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function getVersion(): Promise<string> {
  if (typeof env.npm_package_version === "string" && env.npm_package_version.length > 0) {
    return env.npm_package_version
  }

  const pkgPath = join(__dirname, "..", "package.json")
  const raw = await readFile(pkgPath, "utf8")
  // oxlint-disable-next-line no-unsafe-type-assertion
  const pkg = JSON.parse(raw) as { version?: string }

  if (!pkg.version) {
    throw new Error("Cannot determine monorepo-hash version from package.json")
  }

  return pkg.version
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest, { mode: 0o755 })

    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location, url)
          .toString()

        file.close()
        void download(redirected, dest)
          .then(resolve, reject)

        return
      }

      if (res.statusCode !== 200) {
        file.close()
        reject(new Error(`Download failed with status ${res.statusCode} for ${url}`))

        return
      }

      res.pipe(file)
      file.on("finish", () => {
        file.close()

        try {
          chmodSync(dest, 0o755)
        } catch {
          // ignore (especially on Windows)
          void 0
        }
        resolve()
      })
    })
      .on("error", (err) => {
        file.close()
        reject(err)
      })
  })
}

async function main(): Promise<void> {
  const platformId = await detectPlatformId()

  if (!platformId) {
    console.warn("monorepo-hash : unsupported platform, skipping native binary download")

    return
  }

  const version = await getVersion()
  const assetName = getBinaryBasename(platformId)
  const url = `https://github.com/EDM115/monorepo-hash/releases/download/${version}/${assetName}`
  const destPath = join(__dirname, "monorepo-hash.exe")

  await mkdir(__dirname, { recursive: true })

  try {
    await unlink(destPath)
    await download(url, destPath)
    console.log(`monorepo-hash : downloaded ${assetName} for v${version}`)
  } catch (err) {
    const msg = err instanceof Error
      ? err.message
      : String(err)

    console.warn(`monorepo-hash : failed to download native binary (${msg}), JS implementation will be used instead`)
  }
}

// Only run when invoked directly (postinstall), not when imported
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main()
}
