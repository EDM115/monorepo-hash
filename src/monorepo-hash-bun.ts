// #region imports
import {
  argv,
  CryptoHasher,
  file,
  write,
  YAML,
} from "bun"
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
  exit,
  stdout,
} from "node:process"

import fg from "fast-glob"
import ignore from "ignore"

import { findUp } from "find-up"
// #endregion


// #region types
const PACKAGE_MANAGERS = [ "pnpm", "npm", "deno", "bun", "yarn" ] as const

type PackageManager = (typeof PACKAGE_MANAGERS)[number]

type PnpmWorkspaceConfig = {
  packages?: string[];
  [key: string]: unknown;
}

interface PackageManifest {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

interface PackageInfo {
  dir: string;
  relDir: string;
  deps: string[];
  perFileHashes: Record<string, string>;
  manifest: PackageManifest;
  ownHash?: Buffer;
}

type Meta = {
  dir: string;
  relDir: string;
  manifest: PackageManifest;
  deps: string[];
}
// #endregion


// #region CLI state
let mode: "generate" | "compare" | null = null
let targets: string[] | null = null
let silent = false
let debug = false
let unified = true
let pmOption: PackageManager | null = null
let usePathCache = true

let packageManager: PackageManager | null = null
let repoRoot = ""
let workspaceGlobs: string[] = []

let rootIgnore: ignore.Ignore = ignore()

const displayPathCache = new Map<string, string>()
const existsCache = new Map<string, boolean>()
const needsPathConversion = sep !== "/"
// #endregion

// #region utils
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

export function displayPath(p: string): string {
  if (!needsPathConversion) {
    return p
  }

  let cached = usePathCache
    ? displayPathCache.get(p)
    : p.replace(/\\/g, "/")

  if (cached === undefined) {
    cached = p.replace(/\\/g, "/")
    displayPathCache.set(p, cached)
  }

  return cached
}

export async function exists(f: string): Promise<boolean> {
  const cached = existsCache.get(f)

  if (cached !== undefined) {
    return cached
  }

  const result = await file(f)
    .exists()

  existsCache.set(f, result)

  return result
}

export function zeroPad(num: number, places: number): string {
  return String(num)
    .padStart(places, "0")
}

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

export const NullObj: {
  new<V = unknown>(): Record<string, V>;
} = /* @__PURE__ */ (() => {
  function NullObj(this: unknown): void {
    // intentionally empty
    void 0
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  NullObj.prototype = Object.create(null) as object
  Object.freeze(NullObj.prototype)

  // oxlint-disable-next-line no-unsafe-type-assertion
  return NullObj as unknown as {
    new<V = unknown>(): Record<string, V>;
  }
})()
Object.freeze(NullObj)

export async function getWorkspaceFileList(
  dir: string,
  relDir: string,
  rootIgnore: ignore.Ignore,
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
    const pkgContents = await file(pkgGit)
      .text()

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

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}
// #endregion

// #region Package manager
export async function detectPNPM(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  const wsYaml = await findUp("pnpm-workspace.yaml")

  if (!wsYaml) {
    return null
  }

  const root = dirname(wsYaml)
  // oxlint-disable-next-line no-unsafe-type-assertion
  const config = YAML.parse(await file(wsYaml)
    .text()) as PnpmWorkspaceConfig
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
  const config = await file(denoPath)
    .json() as { workspace?: string[] }
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

export async function detectPkgJson(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  const pkgPath = await findUp(async (dir) => {
    const pkgFile = join(dir, "package.json")

    if (await exists(pkgFile)) {
      // oxlint-disable-next-line no-unsafe-type-assertion
      const data = await file(pkgFile)
        .json() as { workspaces?: unknown }

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
  const pkg = await file(pkgPath)
    .json() as { workspaces?: string[] | { packages?: string[] } }
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

export async function autoDetect(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  return (await detectPNPM())
    ?? (await detectDeno())
    ?? (await detectPkgJson())
}

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
export async function loadDebugFile(dir: string): Promise<Record<string, string> | null> {
  const debugPath = join(dir, ".debug-hash")

  if (!(await exists(debugPath))) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return await file(debugPath)
    .json() as Record<string, string>
}

export async function writeDebugFile(
  dir: string,
  debugMap: Record<string, string>,
): Promise<void> {
  const debugPath = join(dir, ".debug-hash")
  const normalizedMap: Record<string, string> = new NullObj<string>()

  for (const [ key, value ] of Object.entries(debugMap)) {
    normalizedMap[displayPath(key)] = value
  }

  await write(debugPath, JSON.stringify(normalizedMap, null, 2))
}

export async function loadRootDebugFile(rootDir: string): Promise<Record<string, Record<string, string>> | null> {
  const p = join(rootDir, ".debug-hash")

  if (!(await exists(p))) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return await file(p)
    .json() as Record<string, Record<string, string>>
}

export async function writeRootDebugFile(
  rootDir: string,
  map: Record<string, Record<string, string>>,
): Promise<void> {
  const p = join(rootDir, ".debug-hash")
  const normalizedMap: Record<string, Record<string, string>> = new NullObj<Record<string, string>>()

  for (const [ wsKey, perFile ] of Object.entries(map)) {
    const normWsKey = displayPath(wsKey)
    const normPerFile: Record<string, string> = new NullObj<string>()

    for (const [ fileKey, hash ] of Object.entries(perFile)) {
      normPerFile[displayPath(fileKey)] = hash
    }

    normalizedMap[normWsKey] = normPerFile
  }

  await write(p, JSON.stringify(normalizedMap, null, 2))
}

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
export async function computePerFileHashes(
  dir: string,
  fileList: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = new NullObj<string>()

  if (fileList.length === 0) {
    return result
  }

  const CONCURRENCY = 100

  const entries = await mapLimit(fileList, CONCURRENCY, async (rel) => {
    const norm = displayPath(rel)
    const fullPath = join(dir, rel)
    const content = await file(fullPath)
      .arrayBuffer()
    const fileHash = new CryptoHasher("sha256")
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

export function computeOwnHashFromPerFile(
  perFileMap: Record<string, string>,
  sortedKeys: string[],
): Buffer {
  const h = new CryptoHasher("sha256")
  // Reuse a single buffer for hex decoding to reduce allocations, SHA-256 produces 32 bytes (64 hex chars)
  const rawBuffer = Buffer.allocUnsafe(32)

  for (const key of sortedKeys) {
    rawBuffer.write(perFileMap[key], "hex")
    h.update(rawBuffer)
  }

  return h.digest()
}

export function computeFinalHash(
  pkgName: string,
  pkgs: Record<string, PackageInfo>,
  cache: Record<string, string>,
  visiting: Set<string> = new Set(),
): string {
  if (cache[pkgName]) {
    return cache[pkgName]
  }

  // Detect circular dependency
  if (visiting.has(pkgName)) {
    const cycle = Array.from(visiting)
    const cycleStart = cycle.indexOf(pkgName)
    const cyclePath = [ ...cycle.slice(cycleStart), pkgName ].join(" -> ")

    log(`❌ Circular dependency detected : ${cyclePath}`, false, "error")
    exit(6)
  }

  visiting.add(pkgName)

  const pkg = pkgs[pkgName]

  if (!pkg.ownHash) {
    log(`❌ ownHash missing for package ${pkgName}`, false, "error")
    exit(99)
  }

  // Start the chain
  const chain = new CryptoHasher("sha256")
    .update(pkg.ownHash)

  // Then incorporate each dependency's final hash (as Buffer)
  for (const dep of pkg.deps) {
    const depHex = computeFinalHash(dep, pkgs, cache, visiting)
    const depBuf = Buffer.from(depHex, "hex")

    chain.update(depBuf)
  }

  cache[pkgName] = chain.digest("hex")
  visiting.delete(pkgName)

  return cache[pkgName]
}

export async function loadRootHashFile(rootDir: string): Promise<Record<string, string> | null> {
  const p = join(rootDir, ".hash")

  if (!(await exists(p))) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return await file(p)
    .json() as Record<string, string>
}

export async function writeRootHashFile(
  rootDir: string,
  map: Record<string, string>,
): Promise<void> {
  const p = join(rootDir, ".hash")
  const normalized: Record<string, string> = new NullObj<string>()
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

  await write(p, JSON.stringify(normalized, null, 2))
}

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
    const map: Record<string, string> = new NullObj<string>()

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

      await write(hashPath, current)

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

export async function compareHashes(pkgs: Record<string, PackageInfo>, finalCache: Record<string, string>): Promise<{
  unchangedTargets: string[];
  changedTargets: Array<{
    name: string; oldHash: string; newHash: string; changedDeps: string[];
  }>;
  missingTargets: Array<{
    name: string; newHash: string;
  }>;
}> {
  // Load root files in parallel when unified mode is enabled
  const [ rootHashes, rootDebug ] = unified
    ? await Promise.all([
        loadRootHashFile(repoRoot),
        debug
          ? loadRootDebugFile(repoRoot)
          : null,
      ])
    : [ null, null ]

  // Build oldHashMap in a single pass, reading per-workspace files in parallel when not unified
  const pkgEntries = Object.entries(pkgs)
  const oldHashMap: Record<string, string> = new NullObj<string>()

  if (unified) {
    for (const [ pkgName, info ] of pkgEntries) {
      const posixRel = displayPath(info.relDir)
      const oldHex = rootHashes?.[posixRel]

      if (oldHex) {
        oldHashMap[pkgName] = oldHex
      }
    }
  } else {
    // Read all per-workspace hash files in parallel
    const hashResults = await Promise.all(pkgEntries.map(async ([ pkgName, info ]) => {
      const hashPath = join(info.dir, ".hash")
      const existsHash = await exists(hashPath)

      if (!existsHash) {
        return [ pkgName, undefined ] as const
      }

      const oldHex = (await file(hashPath)
        .text()).trim()

      return [ pkgName, oldHex ] as const
    }))

    for (const [ name, hash ] of hashResults) {
      if (hash !== undefined) {
        oldHashMap[name] = hash
      }
    }
  }

  // 1) figure out exactly which workspaces have changed without filtering by targets
  const allChanged = new Set<string>()

  for (const [pkgName] of pkgEntries) {
    const currentHex = finalCache[pkgName]
    const oldHex = oldHashMap[pkgName]

    if (oldHex !== undefined && oldHex !== currentHex) {
      allChanged.add(pkgName)
    }
  }

  // 2) build a quick adjacency map from packageName to its internal deps
  const adjacency: Record<string, string[]> = new NullObj<string[]>()

  for (const [ name, info ] of Object.entries(pkgs)) {
    // deps only includes other workspaces
    adjacency[name] = info.deps.slice()
  }

  // 3) given a pkgName, returns the set of all workspace names it (transitively) depends on
  const transitiveDepsCache: Record<string, Set<string>> = new NullObj<Set<string>>()

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
    exit(1)
  }

  return {
    unchangedTargets,
    changedTargets,
    missingTargets,
  }
}

export async function hash(): Promise<Awaited<ReturnType<typeof generateHashes>> | Awaited<ReturnType<typeof compareHashes>>> {
  // 1) find every workspace's package.json
  const pkgJsonPaths = await fg(
    workspaceGlobs.map((glob) => posix.join(glob, "package.json")),
    {
      onlyFiles: true, dot: true,
    },
  )

  // 2) read package.json files to gather basic info (without hashing yet)
  const meta: Map<string, Meta> = new Map()
  const relToName: Map<string, string> = new Map()

  // Pre-compute paths to avoid repeated path operations in the async loop
  const pathInfos = pkgJsonPaths.map((pkgJson) => {
    const absJson = resolve(repoRoot, pkgJson)
    const dir = dirname(absJson)
    const relDir = relative(repoRoot, dir)

    return {
      absJson, dir, relDir,
    }
  })

  // Read all package.json files in parallel
  const pkgDataList = await Promise.all(pathInfos.map(async ({
    absJson, dir, relDir,
  }) => {
    // oxlint-disable-next-line no-unsafe-type-assertion
    const pkgData = await file(absJson)
      .json() as PackageManifest

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
  const debugOutput: Record<string, Record<string, string>> = new NullObj<Record<string, string>>()
  const pkgInfos = await mapLimit<string, [string, PackageInfo]>(
    toHash,
    concurrency,
    async (pkgName): Promise<[string, PackageInfo]> => {
      const pkgMeta = meta.get(pkgName)

      if (!pkgMeta) {
        log(`❌ Metadata missing for package ${pkgName}`, false, "error")
        exit(99)
      }

      const {
        dir, relDir, manifest, deps,
      } = pkgMeta

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
  const finalCache: Record<string, string> = new NullObj<string>()

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
export async function runCli(customArgv?: string[]): Promise<Awaited<ReturnType<typeof hash>> | undefined> {
  // Reset CLI state for each invocation
  mode = null
  targets = null
  silent = false
  debug = false
  unified = true
  pmOption = null
  usePathCache = true

  // Clear caches for fresh runs
  existsCache.clear()
  displayPathCache.clear()

  // Parse CLI flags
  for (const arg of (customArgv ?? argv.slice(2))) {
    if (arg === "--generate" || arg === "-g") {
      if (mode === "compare") {
        log("❌ Cannot specify both --generate and --compare", false, "error")
        exit(2)
      }

      mode = "generate"
    } else if (arg === "--compare" || arg === "-c") {
      if (mode === "generate") {
        log("❌ Cannot specify both --generate and --compare", false, "error")
        exit(2)
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
        exit(2)
      }

      pmOption = isPackageManager(val)
        ? val
        : null
    } else if (arg === "--nopathcache" || arg === "-npc") {
      usePathCache = false
    } else if (arg === "--help" || arg === "-h") {
      log(`
monorepo-hash by EDM115
A simple script to generate or compare .hash files for monorepo workspaces
Supports PNPM, Yarn, NPM, Bun and Deno

Arguments :
  --generate        (-g)   Generate or update .hash files for all workspaces
  --compare         (-c)   Compare current state with existing .hash files. Capture the exit code to check for changes
  --target="<path>" (-t)   Specify one or more targets to generate/compare (comma-separated)
  --silent          (-s)   Suppress output messages
  --debug           (-d)   Enable debug mode (per-file hashes)
  --workspaces      (-w)   Use per-workspace .hash files instead of a single root one
  --packagemanager  (-pm)  Force the package manager (${PACKAGE_MANAGERS.join(", ")})
  --nopathcache     (-npc) Disable path normalization cache (can reduce memory footprint on very large repos)
  --help            (-h)   Show this help message
`)
      exit(0)
    } else {
      log(`❌ Unknown option : ${arg}`, false, "error")
      exit(3)
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
    exit(2)
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

      exit(5)
    }

    log("❌ No workspaces found or unsupported package manager", false, "error")
    exit(4)
  }

  packageManager = detected?.pm ?? null
  repoRoot = detected?.root ?? ""
  workspaceGlobs = detected?.globs ?? []

  log(`ℹ️  Using ${packageManager} workspaces from ${repoRoot}\n`)

  // Compile root .gitignore
  rootIgnore = ignore()
  const rootGit: string = join(repoRoot, ".gitignore")

  if (await exists(rootGit)) {
    const rootGitContents = await file(rootGit)
      .text()

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
    exit(99)
  }
}

(async () => {
  await runCli()
})()
  .catch((error: unknown) => {
    console.error(error)
  })
// #endregion
