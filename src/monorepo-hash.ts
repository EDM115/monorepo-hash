// #region imports
import type { PathLike } from "node:fs"

import { createHash } from "node:crypto"
import {
  access,
  readFile,
  writeFile,
} from "node:fs/promises"
import { availableParallelism } from "node:os"
import {
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path"
import {
  argv,
  exit,
  stdout,
} from "node:process"
import { pathToFileURL } from "node:url"

import fg from "fast-glob"
import ignore, { type Ignore } from "ignore"

import { findUp } from "find-up"
import { load } from "js-yaml"
// #endregion


// #region types
/**
 * The list of supported package managers
 */
export const PACKAGE_MANAGERS = [ "pnpm", "npm", "deno", "bun", "yarn" ] as const

/**
 * The list of supported package managers as a type
 */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

/**
 * The minimum expected keys in a `pnpm-workspace.yaml`
 */
export type PnpmWorkspaceConfig = {
  packages?: string[];
  [key: string]: unknown;
}

/**
 * The minimum expected keys in a `package.json`
 */
export interface PackageManifest {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * What informations we're expected to get from a package
 */
export interface PackageInfo {
  dir: string;
  relDir: string;
  deps: string[];
  perFileHashes: Record<string, string>;
  manifest: PackageManifest;
  ownHash?: Buffer;
}
// #endregion


// #region CLI state
let mode: "generate" | "compare" | null = null
let targets: string[] | null = null
let silent = false
let debug = false
let unified = true
let cliUsage = true
let pmOption: PackageManager | null = null

let packageManager: PackageManager | null = null
let repoRoot = ""
let workspaceGlobs: string[] = []

let rootIgnore: Ignore = ignore()

const displayPathCache = new Map<string, string>()
const existsCache = new Map<string, boolean>()
const needsPathConversion = sep !== "/"
// #endregion

// #region utils
/**
 * Log messages to console with support for silent mode and overwriting
 * @param message The message to log
 * @param overwrite Whether to overwrite the current line
 * @param level The log level, either "log" or "error"
 */
export function log(message: string, overwrite = false, level: "log" | "error" = "log"): void {
  if (!silent) {
    if (
      overwrite
      // Allow to work when used for example in VS Code's Source Control panel, the output goes in its Output panel which doesn't support refreshed lines
      && stdout.isTTY
      && typeof stdout.clearLine === "function"
      && typeof stdout.cursorTo === "function"
    ) {
      stdout.clearLine(0)
      stdout.cursorTo(0)
      stdout.write(message)
    } else {
      if (level === "log") {
        console.log(message)
      } else {
        console.error(message)
      }
    }
  }
}

/**
 * Normalize a path for display purposes (always POSIX-style separators) and cache the result
 */
export function displayPath(p: string): string {
  if (!needsPathConversion) {
    return p
  }

  let cached = displayPathCache.get(p)

  if (cached === undefined) {
    cached = p.replace(/\\/g, "/")
    displayPathCache.set(p, cached)
  }

  return cached
}

/**
 * Check if a file or directory exists and cache the result
 * @param f The path to check
 * @returns A promise that resolves to true if the path exists, false otherwise
 */
export async function exists(f: PathLike): Promise<boolean> {
  const key = String(f)
  const cached = existsCache.get(key)

  if (cached !== undefined) {
    return cached
  }

  try {
    await access(f)
    existsCache.set(key, true)

    return true
  } catch {
    existsCache.set(key, false)

    return false
  }
}

/**
 * Pad a number with leading zeros
 * @param num The number to pad
 * @param places The total length of the resulting string
 * @returns The padded number as a string
 */
export function zeroPad(num: number, places: number): string {
  return String(num)
    .padStart(places, "0")
}

/**
 * Only exit the process if running as a CLI, otherwise throw an error
 * Exit code 1 won't throw an error to still get the comparison results, and exit code 0 is normal
 * @param code The exit code
 */
export function safeExit(code: number): void {
  if (cliUsage) {
    exit(code)
  } else {
    if (![ 0, 1 ].includes(code)) {
      throw new Error(`Exit with code ${code}`)
    }
  }
}

/**
 * Map over an array with a concurrency limit
 * @param items The array of items to process
 * @param limit The maximum number of concurrent operations
 * @param fn The async function to apply to each item
 * @returns A promise that resolves to an array of results
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let idx = 0

  async function worker() {
    while (idx < items.length) {
      const current = idx++

      // oxlint-disable-next-line no-await-in-loop
      results[current] = await fn(items[current])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  return results
}

/**
 * Given a workspace directory (`dir`) and its repo-relative path (`relDir`), return a sorted array of all file-relative paths (using OS-specific separators), after applying root and package‐level .gitignore filters
 * @param dir The absolute path to the workspace directory
 * @param relDir The repo-relative path to the workspace directory
 * @param rootIgnore The root-level ignore instance to apply
 * @returns A promise that resolves to an array of relative file paths
 */
export async function getWorkspaceFileList(
  dir: string,
  relDir: string,
  rootIgnore: Ignore,
): Promise<string[]> {
  const relDirPosix = displayPath(relDir)

  // Gather all files under `dir`
  const rawFiles = await fg("**/*", {
    cwd: dir,
    onlyFiles: true,
    dot: true,
    // Always ignore .hash and .debug-hash as well as common ignores
    ignore: [ "**/node_modules/**", "**/.git/**", "**/.hash", "**/.debug-hash" ],
  })

  // Early exit if no files
  if (rawFiles.length === 0) {
    return []
  }

  // Convert to POSIX paths for consistent processing (already POSIX from fast-glob)
  const repoPaths = rawFiles.map((f) => posix.join(relDirPosix, f))

  // 1) Apply root .gitignore
  const rootFiltered = rootIgnore.filter(repoPaths)

  // 2) Apply package‐level .gitignore if present
  const pkgGit = join(dir, ".gitignore")
  let pkgFilteredPOSIX: string[]

  if (await exists(pkgGit)) {
    const pkgIgnore = ignore()
    const pkgContents = await readFile(pkgGit, "utf8")

    pkgIgnore.add(pkgContents)

    // Convert back to package‐relative POSIX paths
    const pkgRelativePOSIX = rootFiltered.map((rp) => posix.relative(relDirPosix, rp))

    pkgFilteredPOSIX = pkgIgnore.filter(pkgRelativePOSIX)
  } else {
    // No package .gitignore, just convert paths
    pkgFilteredPOSIX = rootFiltered.map((rp) => posix.relative(relDirPosix, rp))
  }

  // Sort and convert to OS‐specific separators if needed
  pkgFilteredPOSIX.sort()

  if (!needsPathConversion) {
    return pkgFilteredPOSIX
  }

  return pkgFilteredPOSIX.map((f) => f.split("/")
    .join(sep))
}

/**
 * Type guard to check if a string is a valid PackageManager
 * @param value The string to check
 * @returns True if the string is a valid PackageManager, false otherwise
 */
export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}
// #endregion

// #region Package manager
/**
 * Detect PNPM workspaces by locating `pnpm-workspace.yaml` and reading its `packages` field
 * @returns A promise that resolves to an object containing the package manager, root directory, and workspace globs, or null if not detected
 */
export async function detectPNPM(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  const wsYaml = await findUp("pnpm-workspace.yaml")

  if (!wsYaml) {
    return null
  }

  const root = dirname(wsYaml)
  // oxlint-disable-next-line no-unsafe-type-assertion
  const config = load(await readFile(wsYaml, "utf8")) as PnpmWorkspaceConfig
  const globs: string[] = Array.isArray(config.packages)
    ? config.packages
    : []

  if (globs.length === 0) {
    return null
  }

  return {
    pm: "pnpm", root, globs,
  }
}

/**
 * Detect Deno workspaces by locating `deno.json` or `deno.jsonc` and reading its `workspace` field
 * @returns A promise that resolves to an object containing the package manager, root directory, and workspace globs, or null if not detected
 */
export async function detectDeno(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  let denoPath = await findUp("deno.json")

  if (!denoPath) {
    denoPath = await findUp("deno.jsonc")

    if (!denoPath) {
      return null
    }
  }

  const root = dirname(denoPath)
  // oxlint-disable-next-line no-unsafe-type-assertion
  const config = JSON.parse(await readFile(denoPath, "utf8")) as { workspace?: string[] }
  const globs: string[] = Array.isArray(config.workspace)
    ? config.workspace
    : []

  if (globs.length === 0) {
    return null
  }

  return {
    pm: "deno", root, globs,
  }
}

/**
 * Detect workspaces from `package.json` `workspaces` field, supporting Yarn, NPM and Bun
 * @returns A promise that resolves to an object containing the package manager, root directory, and workspace globs, or null if not detected
 */
export async function detectPkgJson(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  const pkgPath = await findUp(async (dir) => {
    const pkgFile = join(dir, "package.json")

    if (await exists(pkgFile)) {
      // oxlint-disable-next-line no-unsafe-type-assertion
      const data = JSON.parse(await readFile(pkgFile, "utf8")) as { workspaces?: unknown }

      if (data.workspaces) {
        return pkgFile
      }
    }

    return undefined
  })

  if (!pkgPath) {
    return null
  }

  const root = dirname(pkgPath)
  // oxlint-disable-next-line no-unsafe-type-assertion
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { workspaces?: string[] | { packages?: string[] } }
  let globs: string[] = []

  if (Array.isArray(pkg.workspaces)) {
    globs = pkg.workspaces
  } else if (pkg.workspaces && Array.isArray((pkg.workspaces as { packages?: string[] }).packages)) {
    globs = (pkg.workspaces as { packages?: string[] }).packages ?? []
  }

  if (globs.length === 0) {
    return null
  }

  const [
    hasBunLock,
    hasBunLockB,
    hasDenoLock,
    hasYarnLock,
  ] = await Promise.all([
    exists(join(root, "bun.lock")),
    exists(join(root, "bun.lockb")),
    exists(join(root, "deno.lock")),
    exists(join(root, "yarn.lock")),
  ])

  if (hasBunLock || hasBunLockB) {
    return {
      pm: "bun", root, globs,
    }
  }

  if (hasDenoLock) {
    return {
      pm: "deno", root, globs,
    }
  }

  if (hasYarnLock) {
    return {
      pm: "yarn", root, globs,
    }
  }

  return {
    pm: "npm", root, globs,
  }
}

/**
 * Auto-detect the package manager and workspaces
 * @returns A promise that resolves to an object containing the package manager, root directory, and workspace globs, or null if not detected
 */
export async function autoDetect(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  return (await detectPNPM())
    ?? (await detectDeno())
    ?? (await detectPkgJson())
}

/**
 * Detect workspaces for a specified package manager
 * @param pm The package manager to detect
 * @returns A promise that resolves to an object containing the package manager, root directory, and workspace globs, or null if not detected
 */
export async function detectSpecified(pm: PackageManager): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  if (pm === "pnpm") {
    return detectPNPM()
  }

  if (pm === "deno") {
    return detectDeno()
  }

  const detectedPm = await detectPkgJson()

  return detectedPm?.pm === pm
    ? detectedPm
    : null
}
// #endregion

// #region debug
/**
 * Load the existing `.debug-hash` JSON from `dir`, if present
 * Otherwise returns null
 * @param dir The directory to load the debug file from
 * @returns A promise that resolves to a record mapping POSIX relative file paths to their SHA-256 hex hashes, or null if the file does not exist
 */
export async function loadDebugFile(dir: string): Promise<Record<string, string> | null> {
  const debugPath = join(dir, ".debug-hash")

  if (!(await exists(debugPath))) {
    return null
  }

  const text = await readFile(debugPath, "utf8")

  // oxlint-disable-next-line no-unsafe-type-assertion
  return JSON.parse(text) as Record<string, string>
}

/**
 * Write a JSON-serialized debug map to `.debug-hash` in `dir`
 * @param dir The directory to write the debug file in
 * @param debugMap A record mapping POSIX relative file paths to their SHA-256 hex hashes
 * @returns A promise that resolves when the file has been written
 */
export async function writeDebugFile(
  dir: string,
  debugMap: Record<string, string>,
): Promise<void> {
  const debugPath = join(dir, ".debug-hash")
  const normalizedMap: Record<string, string> = Object.create(null)

  for (const [ key, value ] of Object.entries(debugMap)) {
    normalizedMap[displayPath(key)] = value
  }

  await writeFile(debugPath, JSON.stringify(normalizedMap, null, 2), "utf8")
}

/**
 * Load the root `.debug-hash` file if present
 * @param rootDir The root directory of the monorepo
 * @returns A promise that resolves to a record mapping workspace relative paths to their per-file hash maps, or null if the file does not exist
 */
export async function loadRootDebugFile(rootDir: string): Promise<Record<string, Record<string, string>> | null> {
  const p = join(rootDir, ".debug-hash")

  if (!(await exists(p))) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return JSON.parse(await readFile(p, "utf8")) as Record<string, Record<string, string>>
}

/**
 * Write all per-file hashes to the root `.debug-hash` file
 * @param rootDir The root directory of the monorepo
 * @param map A record mapping workspace relative paths to their per-file hash maps
 * @returns A promise that resolves when the file has been written
 */
export async function writeRootDebugFile(
  rootDir: string,
  map: Record<string, Record<string, string>>,
): Promise<void> {
  const p = join(rootDir, ".debug-hash")
  const normalizedMap: Record<string, Record<string, string>> = Object.create(null)

  for (const [ wsKey, perFile ] of Object.entries(map)) {
    const normWsKey = displayPath(wsKey)
    const normPerFile: Record<string, string> = Object.create(null)

    for (const [ fileKey, hash ] of Object.entries(perFile)) {
      normPerFile[displayPath(fileKey)] = hash
    }

    normalizedMap[normWsKey] = normPerFile
  }

  await writeFile(p, JSON.stringify(normalizedMap, null, 2), "utf8")
}

/**
 * Generate debug output for a given package, comparing with existing .debug-hash if present
 * @param info The PackageInfo of the package to generate debug for
 * @param oldDebug An optional existing debug map to compare against
 * @returns A promise that resolves to an array of diverging file paths
 */
export async function generateDebug(
  info: PackageInfo,
  oldDebug?: Record<string, string> | null,
): Promise<string[]> {
  if (oldDebug === undefined) {
    oldDebug = await loadDebugFile(info.dir)
  }

  if (oldDebug) {
    // We already have info.perFileHashes from the generate pass
    const newDebug = info.perFileHashes
    const diverged: string[] = []

    // Collect all keys from old and new
    for (const key of new Set([
      ...Object.keys(oldDebug),
      ...Object.keys(newDebug),
    ])) {
      if (oldDebug[key] !== newDebug[key]) {
        diverged.push(key)
      }
    }

    if (diverged.length > 0) {
      log(`⚠️  <debug> ${displayPath(info.relDir)} diverging files :`)
      diverged.forEach((f) => log(`  • ${displayPath(f)}`))
      log("")
    }

    return diverged
  } else {
    log(`❓ <debug> ${displayPath(info.relDir)} has no .debug-hash to compare`)
    log("")

    return []
  }
}
// #endregion

// #region hash compute
/**
 * For a given `dir` and list of relative file paths (`fileList`), compute per-file SHA-256 on (normalizedPath + rawContent)
 * Always returns a map : { "posix/rel/path": "hex" }
 * @param dir The absolute path to the directory containing the files
 * @param fileList An array of relative file paths within the directory
 * @returns A promise that resolves to a record mapping POSIX relative paths to their SHA-256 hex hashes
 */
export async function computePerFileHashes(
  dir: string,
  fileList: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null)

  if (fileList.length === 0) {
    return result
  }

  const CONCURRENCY = 100

  const entries = await mapLimit(fileList, CONCURRENCY, async (rel) => {
    const norm = displayPath(rel)
    const fullPath = join(dir, rel)
    const content = await readFile(fullPath)
    const fileHash = createHash("sha256")
      .update(norm)
      .update(content)
      .digest("hex")

    return [ norm, fileHash ] as const
  })

  for (const [ norm, partialHash ] of entries) {
    result[norm] = partialHash
  }

  return result
}

/**
 * Given a per-file‐hash map and its sorted keys, produce the "ownHash" Buffer by concatenating each raw hash‐buffer (in sorted key order) and feeding them into a SHA-256
 * @param perFileMap A record mapping POSIX relative file paths to their SHA-256 hex hashes
 * @param sortedKeys An array of sorted keys from the perFileMap
 * @returns A Buffer representing the combined SHA-256 hash
 */
export function computeOwnHashFromPerFile(
  perFileMap: Record<string, string>,
  sortedKeys: string[],
): Buffer {
  const h = createHash("sha256")

  for (const key of sortedKeys) {
    // Each entry in perFileMap[key] is a hex string, convert to Buffer
    const raw = Buffer.from(perFileMap[key], "hex")

    h.update(raw)
  }

  return h.digest()
}

/**
 * Recursively compute the final (aggregate) hash for `pkgName`, given a map of all PackageInfo, storing ownHash as Buffer
 * @param pkgName The name of the package to compute the final hash for
 * @param pkgs A record mapping package names to their PackageInfo
 * @param cache A record used to cache computed final hashes
 * @returns The final hash as a hex string
 */
export function computeFinalHash(
  pkgName: string,
  pkgs: Record<string, PackageInfo>,
  cache: Record<string, string>,
): string {
  if (cache[pkgName]) {
    return cache[pkgName]
  }

  const pkg = pkgs[pkgName]

  if (!pkg.ownHash) {
    log(`❌ ownHash missing for package ${pkgName}`, false, "error")
    safeExit(99)
  }

  // Start the chain
  const chain = createHash("sha256")
    .update(pkg.ownHash!)

  // Then incorporate each dependency's final hash (as Buffer)
  for (const dep of pkg.deps) {
    const depHex = computeFinalHash(dep, pkgs, cache)
    const depBuf = Buffer.from(depHex, "hex")

    chain.update(depBuf)
  }

  cache[pkgName] = chain.digest("hex")

  return cache[pkgName]
}

/**
 * Load the mapping of workspace hashes from the root `.hash` file
 * @param rootDir The root directory of the monorepo
 * @returns A promise that resolves to a record mapping workspace relative paths to their final hashes, or null if the file does not exist
 */
export async function loadRootHashFile(rootDir: string): Promise<Record<string, string> | null> {
  const p = join(rootDir, ".hash")

  if (!(await exists(p))) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return JSON.parse(await readFile(p, "utf8")) as Record<string, string>
}

/**
 * Write the mapping of workspace hashes to the root `.hash` file
 * @param rootDir The root directory of the monorepo
 * @param map A record mapping workspace relative paths to their final hashes
 * @returns A promise that resolves when the file has been written
 */
export async function writeRootHashFile(
  rootDir: string,
  map: Record<string, string>,
): Promise<void> {
  const p = join(rootDir, ".hash")
  const normalized: Record<string, string> = Object.create(null)
  const existing = await loadRootHashFile(rootDir)

  // Preserve existing entries not in the new map
  if (existing) {
    for (const [ key, value ] of Object.entries(existing)) {
      normalized[displayPath(key)] = value
    }
  }

  for (const [ key, value ] of Object.entries(map)) {
    normalized[displayPath(key)] = value
  }

  await writeFile(p, JSON.stringify(normalized, null, 2), "utf8")
}

/**
 * Generate and write hashes for all packages
 * @param pkgs A record mapping package names to their PackageInfo
 * @param finalCache A record mapping package names to their final hash strings
 * @returns A promise that resolves to either a record mapping workspace relative paths to their hashes (if unified), or an array of objects containing relDir and hash for each package (if not unified)
 */
export async function generateHashes(
  pkgs: Record<string, PackageInfo>,
  finalCache: Record<string, string>,
): Promise<Record<string, string> | Array<{
  relDir: string; hash: string;
}>> {
  const entries = Object.entries(pkgs)
    // If the user passed --target, only write those relDirs
    .filter(([ _, { relDir }]) => !targets || targets.includes(relDir))

  if (unified) {
    const map: Record<string, string> = Object.create(null)

    for (const [ name, { relDir }] of entries) {
      map[displayPath(relDir)] = finalCache[name]
    }

    await writeRootHashFile(repoRoot, map)

    const sortedEntries = Object.entries(map)
      // oxlint-disable-next-line no-array-sort
      .sort((a, b) => a[0].localeCompare(b[0]))

    for (const [ rel, hash ] of sortedEntries) {
      log(`✅ ${displayPath(rel)} (${hash} written to .hash)`)
    }

    return Object.fromEntries(sortedEntries)
  } else {
    const results = await Promise.all(entries.map(async ([
      name, {
        dir, relDir,
      },
    ]) => {
      const current = finalCache[name]
      const hashPath = join(dir, ".hash")

      await writeFile(hashPath, current)

      return {
        relDir: displayPath(relDir), hash: current,
      }
    }))

    results.sort((a, b) => a.relDir.localeCompare(b.relDir))

    for (const {
      relDir, hash,
    } of results) {
      log(`✅ ${displayPath(relDir)} (${hash} written to .hash)`)
    }

    return results
  }
}

/**
 * Compare current hashes with existing .hash files
 * @param pkgs A record mapping package names to their PackageInfo
 * @param finalCache A record mapping package names to their final hash strings
 * @returns A promise that resolves to an object containing arrays of unchanged, changed, and missing targets
 */
export async function compareHashes(pkgs: Record<string, PackageInfo>, finalCache: Record<string, string>): Promise<{
  unchangedTargets: string[];
  changedTargets: Array<{
    name: string; oldHash: string; newHash: string; changedDeps: string[];
  }>;
  missingTargets: Array<{
    name: string; newHash: string;
  }>;
}> {
  const rootHashes = unified
    ? await loadRootHashFile(repoRoot)
    : null
  const rootDebug = debug && unified
    ? await loadRootDebugFile(repoRoot)
    : null

  // 1) figure out exactly which workspaces have changed without filtering by targets
  const changeChecks = await Promise.all(Object.entries(pkgs)
    .map(async ([ pkgName, info ]) => {
      const currentHex = finalCache[pkgName]

      if (unified) {
        const posixRel = displayPath(info.relDir)
        const oldHex = rootHashes
          ? rootHashes[posixRel]
          : undefined

        if (!oldHex) {
          return {
            pkgName, missing: true,
          }
        }

        return {
          pkgName, missing: false, changed: oldHex !== currentHex,
        }
      } else {
        const hashPath = join(info.dir, ".hash")
        const existsHash = await exists(hashPath)

        if (!existsHash) {
          return {
            pkgName, missing: true,
          }
        }

        const oldHex = (await readFile(hashPath, "utf8")).trim()

        return {
          pkgName, missing: false, changed: oldHex !== currentHex,
        }
      }
    }))

  const allChanged = new Set(changeChecks
    .filter((r) => !r.missing && r.changed)
    .map((r) => r.pkgName))

  // 2) build a quick adjacency map from packageName to its internal deps
  const adjacency: Record<string, string[]> = Object.create(null)

  for (const [ name, info ] of Object.entries(pkgs)) {
    // deps only includes other workspaces
    adjacency[name] = info.deps.slice()
  }

  // 3) given a pkgName, returns the set of all workspace names it (transitively) depends on
  const transitiveDepsCache: Record<string, Set<string>> = Object.create(null)

  function getTransitiveDeps(pkgName: string): Set<string> {
    if (transitiveDepsCache[pkgName]) {
      return transitiveDepsCache[pkgName]
    }

    const visited = new Set<string>()
    const stack = [...adjacency[pkgName]]

    while (stack.length > 0) {
      const dep = stack.pop()!

      if (!visited.has(dep)) {
        visited.add(dep)
        // push that dep's deps too
        ; (adjacency[dep] || []).forEach((d) => {
          if (!visited.has(d)) {
            stack.push(d)
          }
        })
      }
    }

    transitiveDepsCache[pkgName] = visited

    return visited
  }

  /*
  4) prepare three lists (but only for targets) :
      - unchangedTargets (requested targets whose hash == .hash on disk, AND no changed deps)
      - changedTargets (requested targets whose own-hash differs OR who have changed deps)
      - missingTargets (requested targets with no .hash file on disk)
     and for each changedTarget we'll also gather exactly which of its transitiveDeps appear in allChanged
  */
  const unchangedTargets: string[] = []
  const changedTargets: Array<{
    name: string;
    oldHash: string;
    newHash: string;
    changedDeps: string[];
  }> = []
  const missingTargets: Array<{
    name: string; newHash: string;
  }> = []

  // We need a map pkgName to oldHash so we can report old when it changed
  const oldMapEntries = await Promise.all(Object.entries(pkgs)
    .map(async ([ pkgName, info ]) => {
      if (unified) {
        const posixRel = displayPath(info.relDir)
        const oldHex = rootHashes
          ? rootHashes[posixRel]
          : undefined

        if (!oldHex) {
          return null
        }

        return [ pkgName, oldHex ] as [string, string]
      } else {
        const hashPath = join(info.dir, ".hash")

        if (!(await exists(hashPath))) {
          return null
        }

        const oldHex = (await readFile(hashPath, "utf8")).trim()

        return [ pkgName, oldHex ] as [string, string]
      }
    }))
  const oldHashMap: Record<string, string> = Object.create(null)

  oldMapEntries.forEach((entry) => {
    if (entry) {
      const [ name, hex ] = entry

      oldHashMap[name] = hex
    }
  })

  // 5) finally, iterate only over the workspaces the user asked for
  const toCheck = targets
    ? Object.entries(pkgs)
        .filter(([ , info ]) => targets?.includes(info.relDir))
    : Object.entries(pkgs)

  const checkResults = await Promise.all(toCheck.map(async ([ pkgName, info ]) => {
    const newHash = finalCache[pkgName]
    const posixRel = displayPath(info.relDir)
    const oldHash = pkgName in oldHashMap
      ? oldHashMap[pkgName]
      : undefined
    const existsHash = oldHash !== undefined && typeof oldHash === "string"

    if (!existsHash) {
      return {
        type: "missing" as const,
        name: posixRel,
        newHash,
        oldHash: newHash,
        changedDeps: [] as string[],
      }
    }

    // If debug AND there's an existing .debug-hash, compare per-file maps
    if (debug) {
      if (unified && rootDebug) {
        const oldDebug = rootDebug[posixRel] || null

        await generateDebug(info, oldDebug)
      } else if (!unified && existsHash) {
        await generateDebug(info)
      }
    }

    const transitiveDeps = getTransitiveDeps(pkgName)
    const depsChanged = Array.from(transitiveDeps)
      .filter((d) => allChanged.has(d))
    const changedDepsRelDir = depsChanged.map((d) => pkgs[d].relDir)

    if (oldHash !== newHash || depsChanged.length > 0) {
      return {
        type: "changed" as const,
        name: posixRel,
        oldHash,
        newHash,
        changedDeps: changedDepsRelDir,
      }
    }

    return {
      type: "unchanged" as const,
      name: posixRel,
      newHash,
      oldHash: newHash,
      changedDeps: [] as string[],
    }
  }))

  for (const res of checkResults) {
    if (res.type === "missing") {
      missingTargets.push({
        name: res.name, newHash: res.newHash,
      })
    } else if (res.type === "changed") {
      changedTargets.push({
        name: res.name,
        oldHash: res.oldHash,
        newHash: res.newHash,
        changedDeps: res.changedDeps,
      })
    } else {
      unchangedTargets.push(res.name)
    }
  }

  // Sort each category alphabetically
  unchangedTargets.sort((a, b) => a.localeCompare(b))
  changedTargets.sort((a, b) => a.name.localeCompare(b.name))
  changedTargets.forEach((r) => {
    r.changedDeps.sort((a, b) => a.localeCompare(b))
  })
  missingTargets.sort((a, b) => a.name.localeCompare(b.name))

  // Display results grouped by category
  if (unchangedTargets.length > 0) {
    log(`✅ Unchanged (${unchangedTargets.length}) :`)
    unchangedTargets.forEach((r) => log(`• ${displayPath(r)}`))
    log("")
  }

  if (changedTargets.length > 0) {
    log(`⚠️  Changed (${changedTargets.length}) :`)

    for (const {
      name, oldHash, newHash, changedDeps,
    } of changedTargets) {
      log(`• ${displayPath(name)}`)
      log(`\told : ${oldHash}`)
      log(`\tnew : ${newHash}`)

      if (changedDeps.length > 0) {
        log("\t🚧 changed dependency(s) :")
        changedDeps.forEach((d) => log(`\t\t• ${displayPath(d)}`))
      }
    }

    log("")
  }

  if (missingTargets.length > 0) {
    log(`❓ Missing .hash files (${missingTargets.length}) :`)
    missingTargets.forEach(({
      name, newHash,
    }) => log(`• ${displayPath(name)} (would be ${newHash})`))
    log("")
  }

  if (
    mode === "compare"
    && (changedTargets.length > 0 || missingTargets.length > 0)
  ) {
    safeExit(1)
  }

  return {
    unchangedTargets,
    changedTargets,
    missingTargets,
  }
}

/**
 * Compute hashes for all workspaces in the monorepo
 * @returns A promise that resolves to either the result of generateHashes or compareHashes, depending on the mode
 */
export async function hash(): Promise<Awaited<ReturnType<typeof generateHashes>> | Awaited<ReturnType<typeof compareHashes>>> {
  // 1) find every workspace's package.json
  const pkgJsonPaths = await fg(
    workspaceGlobs.map((glob) => posix.join(glob, "package.json")),
    {
      onlyFiles: true, dot: true,
    },
  )

  // 2) read package.json files to gather basic info (without hashing yet)
  type Meta = {
    dir: string;
    relDir: string;
    manifest: PackageManifest;
    deps: string[];
  }

  const meta: Map<string, Meta> = new Map()
  const relToName: Map<string, string> = new Map()

  // Read all package.json files in parallel
  const pkgDataList = await Promise.all(pkgJsonPaths.map(async (pkgJson) => {
    const absJson = resolve(repoRoot, pkgJson)
    const dir = dirname(absJson)
    const relDir = relative(repoRoot, dir)
    const content = await readFile(absJson, "utf8")
    // oxlint-disable-next-line no-unsafe-type-assertion
    const pkgData = JSON.parse(content) as PackageManifest

    return {
      dir, relDir, pkgData,
    }
  }))

  for (const {
    dir, relDir, pkgData,
  } of pkgDataList) {
    const pkgName: string = pkgData.name

    meta.set(pkgName, {
      dir, relDir, manifest: pkgData, deps: [],
    })
    relToName.set(relDir, pkgName)
  }

  // Resolve internal deps for all packages
  for (const info of meta.values()) {
    const {
      dependencies, devDependencies, peerDependencies,
    } = info.manifest

    // Collect dep keys without creating intermediate merged object
    const depKeys: string[] = []

    if (dependencies) {
      for (const d of Object.keys(dependencies)) {
        if (meta.has(d)) {
          depKeys.push(d)
        }
      }
    }

    if (devDependencies) {
      for (const d of Object.keys(devDependencies)) {
        if (meta.has(d) && !depKeys.includes(d)) {
          depKeys.push(d)
        }
      }
    }

    if (peerDependencies) {
      for (const d of Object.keys(peerDependencies)) {
        if (meta.has(d) && !depKeys.includes(d)) {
          depKeys.push(d)
        }
      }
    }

    // oxlint-disable-next-line no-array-sort
    info.deps = depKeys.sort()
  }

  // Determine which packages actually need hashing
  const namesToProcess = new Set<string>()

  function addWithDeps(pkgName: string): void {
    if (namesToProcess.has(pkgName)) {
      return
    }

    namesToProcess.add(pkgName)
    const pkgMeta = meta.get(pkgName)

    if (pkgMeta) {
      for (const dep of pkgMeta.deps) {
        addWithDeps(dep)
      }
    }
  }

  if (targets) {
    for (const t of targets) {
      const name = relToName.get(t)

      if (name) {
        addWithDeps(name)
      }
    }
  } else {
    for (const n of meta.keys()) {
      namesToProcess.add(n)
    }
  }

  const toHash = Array.from(namesToProcess)
  const total = toHash.length
  const pad = total < 10
    ? 1
    : total < 100
      ? 2
      : total < 1000
        ? 3
        : 4

  // 3) compute per-file hashes and ownHash buffers only for required packages
  let count = 0

  log(`\r🔄 Computing hashes (${zeroPad(count, pad)}/${total})`, true)

  const concurrency = Math.max(2, availableParallelism())
  const debugOutput: Record<string, Record<string, string>> = Object.create(null)
  const pkgInfos = await mapLimit<string, [string, PackageInfo]>(
    toHash,
    concurrency,
    async (pkgName): Promise<[string, PackageInfo]> => {
      const pkgMeta = meta.get(pkgName)

      if (!pkgMeta) {
        log(`❌ Metadata missing for package ${pkgName}`, false, "error")
        safeExit(99)
      }

      const {
        dir, relDir, manifest, deps,
      } = pkgMeta!

      // Get file list after ignores
      const fileList = await getWorkspaceFileList(dir, relDir, rootIgnore)

      // Compute per-file hashes & ownHash
      const perFileMap = await computePerFileHashes(dir, fileList)
      const sortedKeys = Object.keys(perFileMap)
        // oxlint-disable-next-line no-array-sort
        .sort()
      const ownBuffer = computeOwnHashFromPerFile(perFileMap, sortedKeys)

      count++
      log(`\r🔄 Computing hashes (${zeroPad(count, pad)}/${total}) • ${displayPath(relDir)}`, true)

      if (debug && mode === "generate") {
        if (unified) {
          debugOutput[displayPath(relDir)] = perFileMap
        } else {
          await writeDebugFile(dir, perFileMap)
        }
      }

      return [
        pkgName,
        {
          dir,
          relDir,
          deps,
          perFileHashes: perFileMap,
          manifest,
          ownHash: ownBuffer,
        },
      ]
    },
  )

  if (mode === "generate" && debug && unified) {
    await writeRootDebugFile(repoRoot, debugOutput)
  }

  const pkgs = Object.fromEntries(pkgInfos)

  log(`\r✅ Computed all hashes (${total})`, true)
  log("\n")

  // 4) recursively compute final hash (aggregate) for needed packages
  const finalCache: Record<string, string> = Object.create(null)

  for (const pkgName of toHash) {
    computeFinalHash(pkgName, pkgs, finalCache)
  }

  // 5) perform generate or compare
  if (mode === "generate") {
    return await generateHashes(pkgs, finalCache)
  } else {
    return await compareHashes(pkgs, finalCache)
  }
}
// #endregion

// #region run
/**
 * CLI entry point : parse arguments, detect workspaces, and run the hash routine
 * This is only invoked when the module is executed directly, not when imported
 * @param customArgv Optional array of command-line arguments (defaults to process.argv)
 * @returns A promise that resolves to the result of the hash operation, or undefined if exiting early
 */
export async function runCli(customArgv?: string[]): Promise<Awaited<ReturnType<typeof hash>> | undefined> {
  // Reset CLI state for each invocation
  mode = null
  targets = null
  silent = false
  debug = false
  unified = true
  pmOption = null
  cliUsage = customArgv === undefined

  // Clear caches for fresh runs
  existsCache.clear()
  displayPathCache.clear()

  const args = customArgv ?? argv.slice(2)

  // Parse CLI flags
  for (const arg of args) {
    if (arg === "--generate" || arg === "-g") {
      if (mode === "compare") {
        log("❌ Cannot specify both --generate and --compare", false, "error")
        safeExit(2)
      }

      mode = "generate"
    } else if (arg === "--compare" || arg === "-c") {
      if (mode === "generate") {
        log("❌ Cannot specify both --generate and --compare", false, "error")
        safeExit(2)
      }

      mode = "compare"
    } else if (arg.startsWith("--target=") || arg.startsWith("-t=")) {
      const [ , val ] = arg.split("=")

      targets = val.split(",")
        .map((p) => p.replace(/\/+$/, ""))
    } else if (arg === "--silent" || arg === "-s") {
      silent = true
    } else if (arg === "--debug" || arg === "-d") {
      debug = true
    } else if (arg === "--workspaces" || arg === "-w") {
      unified = false
    } else if (arg.startsWith("--packagemanager=") || arg.startsWith("-pm=")) {
      const [ , val ] = arg.split("=")

      if (!isPackageManager(val)) {
        log(`❌ Invalid package manager ("${val}"), supported values are : ${PACKAGE_MANAGERS.join(", ")}`, false, "error")
        safeExit(2)
      }

      pmOption = isPackageManager(val)
        ? val
        : null
    } else if (arg === "--help" || arg === "-h") {
      log(`
monorepo-hash by EDM115
A simple script to generate or compare .hash files for monorepo workspaces
Supports PNPM, Yarn, NPM, Bun and Deno

Arguments :
  --generate        (-g)  Generate or update .hash files for all workspaces
  --compare         (-c)  Compare current state with existing .hash files. Capture the exit code to check for changes
  --target="<path>" (-t)  Specify one or more targets to generate/compare (comma-separated)
  --silent          (-s)  Suppress output messages
  --debug           (-d)  Enable debug mode (per-file hashes)
  --workspaces      (-w)  Use per-workspace .hash files instead of a single root one
  --packagemanager  (-pm) Force the package manager (${PACKAGE_MANAGERS.join(", ")})
  --help            (-h)  Show this help message
`)
      safeExit(0)
    } else {
      log(`❌ Unknown option : ${arg}`, false, "error")
      safeExit(3)
    }
  }

  // Normalize targets from forward-slash to platform-specific separators
  if (targets && needsPathConversion) {
    targets = targets.map((t) => t.replace(/\/+$/, "")
      .split("/")
      .join(sep))
  }

  if (!mode) {
    log("❌ Must specify either --generate (-g) or --compare (-c)", false, "error")
    safeExit(2)
  } else {
    if (mode === "generate") {
      if (targets) {
        log(`ℹ️  Generating hashes for specified targets... (${displayPath(targets.join(", "))})\n`)
      } else {
        log("ℹ️  Generating hashes for all workspaces...\n")
      }
    } else {
      if (targets) {
        log(`ℹ️  Comparing hashes for specified targets... (${displayPath(targets.join(", "))})\n`)
      } else if (targets === null) {
        log("ℹ️  Comparing hashes for all workspaces...\n")
      }
    }

    if (debug) {
      log("ℹ️  Debug mode enabled\n")
    }

    if (!unified) {
      log("ℹ️  Per-workspace mode enabled\n")
    }
  }

  const detected = pmOption
    ? await detectSpecified(pmOption)
    : await autoDetect()

  if (!detected) {
    if (pmOption) {
      const auto = await autoDetect()

      if (auto) {
        log(`❌ ${pmOption} workspaces not found. Did you mean --packagemanager=${auto.pm}?`, false, "error")
      } else {
        log("❌ Specified package manager not found and no supported package manager detected", false, "error")
      }

      safeExit(5)
    }

    log("❌ No workspaces found or unsupported package manager", false, "error")
    safeExit(4)
  }

  packageManager = detected?.pm ?? null
  repoRoot = detected?.root ?? ""
  workspaceGlobs = detected?.globs ?? []

  log(`ℹ️  Using ${packageManager} workspaces from ${repoRoot}\n`)

  // Compile root .gitignore
  rootIgnore = ignore()
  const rootGit: string = join(repoRoot, ".gitignore")

  if (await exists(rootGit)) {
    const rootGitContents = await readFile(rootGit, "utf8")

    rootIgnore = ignore()
      .add(rootGitContents)
    // Ignore hashes
    rootIgnore.add("**/.hash")
    rootIgnore.add("**/.debug-hash")
  }

  try {
    return await hash()
  } catch (err) {
    log("❌ Unexpected error :", false, "error")
    log(err instanceof Error
      ? err.message
      : String(err), false, "error")
    safeExit(99)
  }
}

export default runCli

// Auto-run only when executed as the main entry point (not when imported)
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  await runCli()
}
// #endregion
