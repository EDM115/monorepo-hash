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
      await unlinkIfExists(destPath)

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
    const binMappings: Array<readonly [string, string]> = [
      [ jsImplBase, destBase ],
      [ jsImplCmd, destCmd ],
      [ jsImplPs1, destPs1 ],
    ]

    await Promise.all(binMappings.map(async ([ src, dest ]) => {
      await unlinkIfExists(dest)

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
  const npmPackageVersion = env["npm_package_version"]

  if (typeof npmPackageVersion === "string" && npmPackageVersion.length > 0) {
    return npmPackageVersion
  }

  const pkgPath = join(__dirname, "..", "package.json")
  const raw = await readFile(pkgPath, "utf8")
  // oxlint-disable-next-line no-unsafe-type-assertion
  const pkg = JSON.parse(raw) as { version?: string }

  return pkg.version ?? ""
}

/**
 * Remove a file if it exists
 * @param filePath The file path to delete
 * @returns A promise that resolves once the file is deleted or confirmed missing
 */
export async function unlinkIfExists(filePath: string): Promise<void> {
  await unlink(filePath)
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
}

/**
 * Derive a variant asset name from the default binary asset name
 * @param assetName The default asset name
 * @param variant The binary variant to derive
 * @returns The variant asset name
 */
export function getVariantAssetName(assetName: string, variant: "go" | "rust"): string {
  return assetName.replace("monorepo-hash-", `monorepo-hash-${variant}-`)
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
  const releaseBaseUrl = `https://github.com/EDM115/monorepo-hash/releases/download/${version}`
  const url = `${releaseBaseUrl}/${assetName}`
  const destPath = join(__dirname, "monorepo-hash.exe")

  const optionalBinaryTargets = await Promise.all(([
    [ "go", join(__dirname, "monorepo-hash-go.exe") ],
    [ "rust", join(__dirname, "monorepo-hash-rust.exe") ],
  ] as const).map(async ([ variant, variantDestPath ]) => {
    if (!await exists(variantDestPath)) {
      return null
    }

    return {
      assetName: getVariantAssetName(assetName, variant),
      destPath: variantDestPath,
    }
  }))

  await mkdir(__dirname, { recursive: true })

  try {
    await unlinkIfExists(destPath)

    await download(url, destPath)
    console.log(`monorepo-hash : downloaded ${assetName} for v${version}`)
  } catch (err) {
    const msg = errorToMsg(err)

    console.warn(`monorepo-hash : failed to download native binary (${msg}), JS implementation will be used instead`)

    await deferToJSImplementation()

    return
  }

  await Promise.all(optionalBinaryTargets.map(async (optionalBinaryTarget) => {
    if (!optionalBinaryTarget) {
      return
    }

    const variantUrl = `${releaseBaseUrl}/${optionalBinaryTarget.assetName}`

    try {
      await unlinkIfExists(optionalBinaryTarget.destPath)
      await download(variantUrl, optionalBinaryTarget.destPath)
      console.log(`monorepo-hash : downloaded ${optionalBinaryTarget.assetName} for v${version}`)
    } catch (err) {
      const msg = errorToMsg(err)

      console.warn(`monorepo-hash : failed to download ${optionalBinaryTarget.assetName} (${msg}), skipping optional binary`)
    }
  }))
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
