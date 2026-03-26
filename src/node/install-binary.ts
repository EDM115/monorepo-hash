import {
  createWriteStream,
  chmodSync,
} from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  unlink,
} from "node:fs/promises"
import {
  Agent,
  get,
} from "node:https"
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
  type LibcFamily,
  type PlatformId,
  detectLibcFamily,
  detectPlatformId,
  exists,
  getBinaryBasename,
  resolveBinaryPath,
} from "./platform"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const noKeepAliveAgent = new Agent({ keepAlive: false })

/**
 * Convert an unknown error to a string message
 * @param err The error to convert
 * @returns The error message as a string
 */
export function errorToMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }

  return String(err)
}

/**
 * **DO NOT CALL THIS FUNCTION YOURSELF !**
 * 
 * Internal function used to replace the decoy binary with the actual JS implementation if the native binary cannot be downloaded, is not supported on the current platform or the version cannot be determined
 * @returns A promise that resolves when the process is complete
 */
export async function deferToJSImplementation(): Promise<void> {
  const binDir = join(__dirname, "..", "node_modules", ".bin")

  if (!await exists(binDir)) {
    console.warn("monorepo-hash : node_modules/.bin directory does not exist, falling back to Unix-only compatible deferring")

    const destPath = join(__dirname, "monorepo-hash.exe")
    const jsImplPath = join(__dirname, "monorepo-hash.mjs")

    try {
      await unlink(destPath)
        .catch((err: unknown) => {
          if (
            typeof err === "object"
            && err !== null
            && "code" in err
            // oxlint-disable-next-line no-unsafe-type-assertion
            && (err as { code?: string }).code === "ENOENT"
          ) {
            return
          }

          throw err
        })

      await copyFile(jsImplPath, destPath)

      try {
        await chmod(destPath, 0o755)
      } catch {
        // ignore (especially on Windows)
        void 0
      }

      console.warn("monorepo-hash : using JS implementation instead of native binary")
    } catch (err) {
      const msg = errorToMsg(err)

      console.warn(`monorepo-hash : failed to set up JS implementation (${msg}), functionality may be limited`)
    }

    return
  }

  const jsImplBase = join(binDir, "monorepo-hash-js")
  const jsImplCmd = `${jsImplBase}.cmd`
  const jsImplPs1 = `${jsImplBase}.ps1`

  const destBase = join(binDir, "monorepo-hash")
  const destCmd = `${destBase}.cmd`
  const destPs1 = `${destBase}.ps1`

  try {
    await Promise.all([
      [ jsImplBase, destBase ],
      [ jsImplCmd, destCmd ],
      [ jsImplPs1, destPs1 ],
    ].map(async ([ src, dest ]) => {
      await unlink(dest)
        .catch((err: unknown) => {
          if (
            typeof err === "object"
            && err !== null
            && "code" in err
            // oxlint-disable-next-line no-unsafe-type-assertion
            && (err as { code?: string }).code === "ENOENT"
          ) {
            return
          }

          throw err
        })

      await copyFile(src, dest)

      try {
        await chmod(dest, 0o755)
      } catch {
          // ignore (especially on Windows)
        void 0
      }
    }))

    console.warn("monorepo-hash : using JS implementation instead of native binary")
  } catch (err) {
    const msg = errorToMsg(err)

    console.warn(`monorepo-hash : failed to set up JS implementation (${msg}), functionality may be limited`)
  }
}

/**
 * Get the current version of the monorepo-hash package
 * @returns A promise that resolves to the version string
 */
export async function getVersion(): Promise<string> {
  if (typeof env.npm_package_version === "string" && env.npm_package_version.length > 0) {
    return env.npm_package_version
  }

  const pkgPath = join(__dirname, "..", "package.json")
  const raw = await readFile(pkgPath, "utf8")
  // oxlint-disable-next-line no-unsafe-type-assertion
  const pkg = JSON.parse(raw) as { version?: string }

  return pkg.version ?? ""
}

/**
 * Download a file from a URL to a destination path
 * @param url The URL to download from
 * @param dest The destination file path
 * @returns A promise that resolves when the download is complete
 */
export function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let file: ReturnType<typeof createWriteStream> | null = null

    get(url, { agent: noKeepAliveAgent }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location, url)
          .toString()

        void download(redirected, dest)
          .then(resolve, reject)

        return
      }

      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`Download failed with status ${res.statusCode} for ${url}`))

        return
      }

      file = createWriteStream(dest, { mode: 0o755 })
      res.pipe(file)
      file.on("finish", () => {
        file!.close()

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
        file?.close()
        reject(err)
      })
  })
}

/**
 * The main function to download the native binary for the current platform
 * @returns A promise that resolves when the process is complete
 */
export async function main(): Promise<void> {
  const platformId = await detectPlatformId()

  if (!platformId) {
    console.warn("monorepo-hash : unsupported platform, skipping native binary download")

    await deferToJSImplementation()

    return
  }

  let version = ""

  try {
    version = await getVersion()
  } catch (err) {
    const msg = errorToMsg(err)

    console.warn(`monorepo-hash : failed to determine package version (${msg}), skipping native binary download`)

    await deferToJSImplementation()

    return
  }

  if (version.length === 0) {
    console.warn("monorepo-hash : could not determine package version, skipping native binary download")

    await deferToJSImplementation()

    return
  }

  const assetName = getBinaryBasename(platformId)
  const url = `https://github.com/EDM115/monorepo-hash/releases/download/${version}/${assetName}`
  const destPath = join(__dirname, "monorepo-hash.exe")

  await mkdir(__dirname, { recursive: true })

  try {
    await unlink(destPath)
      .catch((err: unknown) => {
        if (
          typeof err === "object"
          && err !== null
          && "code" in err
          // oxlint-disable-next-line no-unsafe-type-assertion
          && (err as { code?: string }).code === "ENOENT"
        ) {
          return
        }

        throw err
      })

    await download(url, destPath)
    console.log(`monorepo-hash : downloaded ${assetName} for v${version}`)
  } catch (err) {
    const msg = errorToMsg(err)

    console.warn(`monorepo-hash : failed to download native binary (${msg}), JS implementation will be used instead`)

    await deferToJSImplementation()
  }
}

// Only run when invoked directly (postinstall), not when imported
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main()
}

// re-export platform utilities
export {
  type LibcFamily,
  type PlatformId,
  detectLibcFamily,
  detectPlatformId,
  exists,
  getBinaryBasename,
  resolveBinaryPath,
}

export default main
