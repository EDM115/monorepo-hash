// #region imports
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
import ignore, { type Ignore } from "ignore"

import { findUp } from "find-up"
import { load } from "js-yaml"
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
// #endregion


// #region CLI state
let mode: "generate" | "compare" | null = null
let targets: string[] | null = null
let silent = false
let debug = false
let unified = true
let pmOption: PackageManager | null = null

let packageManager: PackageManager | null = null
let repoRoot = ""
let workspaceGlobs: string[] = []

let rootIgnore: Ignore = ignore()
// #endregion

// #region utils
function log(message: string, overwrite = false) {
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
      console.log(message)
    }
  }
}

function displayPath(p: string) {
  return p.replace(/\\/g, "/")
}

function zeroPad(num: number, places: number) {
  return String(num)
    .padStart(places, "0")
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
) {
  const results: R[] = Array.from({ length: items.length })
  let idx = 0

  async function worker() {
    while (idx < items.length) {
      const current = idx++

      // oxlint-disable-next-line no-await-in-loop
      results[current] = await fn(items[current])
    }
  }

  const workers = Array.from({ length: limit })
    .map(() => worker())

  await Promise.all(workers)

  return results
}

async function getWorkspaceFileList(
  dir: string,
  relDir: string,
  rootIgnore: Ignore,
) {
  // Gather all files under `dir`
  const rawFiles = await fg("**/*", {
    cwd: dir, onlyFiles: true, dot: true,
  })

  // Convert to POSIX paths for consistent processing
  const posixFiles = rawFiles.map((f) => displayPath(f))
  const relDirPosix = displayPath(relDir)
  const repoPaths = posixFiles.map((f) => posix.join(relDirPosix, f))

  // 1) Apply root .gitignore
  const rootFiltered = rootIgnore.filter(repoPaths)

  // 2) Apply package‐level .gitignore if present
  const pkgIgnore = ignore()
  const pkgGit = join(dir, ".gitignore")

  if (await Bun.file(pkgGit)
    .exists()) {
    const pkgContents = await Bun.file(pkgGit)
      .text()

    pkgIgnore.add(pkgContents)
  }

  // Always ignore .hash and .debug-hash
  pkgIgnore.add(".hash")
  pkgIgnore.add(".debug-hash")

  // Convert back to package‐relative POSIX paths
  const pkgRelativePOSIX = rootFiltered.map((rp) => posix.relative(relDirPosix, rp))
  const pkgFilteredPOSIX = pkgIgnore.filter(pkgRelativePOSIX)

  // Convert to OS‐specific separators and sort
  return pkgFilteredPOSIX.map((f) => f.split("/")
    .join(sep))
    .toSorted()
}

function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}
// #endregion

// #region Package manager
async function detectPNPM(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  const wsYaml = await findUp("pnpm-workspace.yaml")

  if (!wsYaml || !(await Bun.file(wsYaml)
    .exists())) {
    return null
  }

  const root = dirname(wsYaml)
  // oxlint-disable-next-line no-unsafe-type-assertion
  const config = load(await Bun.file(wsYaml)
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

async function detectDeno(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  let denoPath = await findUp("deno.json")

  if (!denoPath || !(await Bun.file(denoPath)
    .exists())) {
    denoPath = await findUp("deno.jsonc")

    if (!denoPath || !(await Bun.file(denoPath)
      .exists())) {
      return null
    }
  }

  const root = dirname(denoPath)
  // oxlint-disable-next-line no-unsafe-type-assertion
  const config = await Bun.file(denoPath)
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

async function detectPkgJson(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  const pkgPath = await findUp(async (dir) => {
    const pkgFile = join(dir, "package.json")

    if (await Bun.file(pkgFile)
      .exists()) {
      // oxlint-disable-next-line no-unsafe-type-assertion
      const data = await Bun.file(pkgFile)
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
  const pkg = await Bun.file(pkgPath)
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

  if (await Bun.file(join(root, "bun.lock"))
    .exists() || await Bun.file(join(root, "bun.lockb"))
    .exists()) {
    return {
      pm: "bun", root, globs,
    }
  }

  if (await Bun.file(join(root, "deno.lock"))
    .exists()) {
    return {
      pm: "deno", root, globs,
    }
  }

  if (await Bun.file(join(root, "yarn.lock"))
    .exists()) {
    return {
      pm: "yarn", root, globs,
    }
  }

  if (await Bun.file(join(root, "package-lock.json"))
    .exists()) {
    return {
      pm: "npm", root, globs,
    }
  }

  return null
}

async function autoDetect(): Promise<{
  pm: PackageManager; root: string; globs: string[];
} | null> {
  return (await detectPNPM())
    ?? (await detectDeno())
    ?? (await detectPkgJson())
}

async function detectSpecified(pm: PackageManager): Promise<{
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
async function writeDebugFile(
  dir: string,
  debugMap: Record<string, string>,
) {
  const debugPath = join(dir, ".debug-hash")
  const normalizedMap: Record<string, string> = {}

  for (const [ key, value ] of Object.entries(debugMap)) {
    normalizedMap[displayPath(key)] = value
  }

  await Bun.write(debugPath, JSON.stringify(normalizedMap, null, 2))
}

async function loadDebugFile(dir: string) {
  const debugPath = join(dir, ".debug-hash")

  if (!(await Bun.file(debugPath)
    .exists())) {
    return null
  }

  const text = await Bun.file(debugPath)
    .text()

  // oxlint-disable-next-line no-unsafe-type-assertion
  return JSON.parse(text) as Record<string, string>
}

async function writeRootDebugFile(
  rootDir: string,
  map: Record<string, Record<string, string>>,
) {
  const p = join(rootDir, ".debug-hash")
  const normalizedMap: Record<string, Record<string, string>> = {}

  for (const [ wsKey, perFile ] of Object.entries(map)) {
    const normWsKey = displayPath(wsKey)
    const normPerFile: Record<string, string> = {}

    for (const [ fileKey, hash ] of Object.entries(perFile)) {
      normPerFile[displayPath(fileKey)] = hash
    }

    normalizedMap[normWsKey] = normPerFile
  }

  await Bun.write(p, JSON.stringify(normalizedMap, null, 2))
}

async function loadRootDebugFile(rootDir: string) {
  const p = join(rootDir, ".debug-hash")

  if (!(await Bun.file(p)
    .exists())) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return await Bun.file(p)
    .json() as Record<string, Record<string, string>>
}

async function generateDebug(
  info: PackageInfo,
  oldDebug?: Record<string, string> | null,
) {
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
async function computePerFileHashes(
  dir: string,
  fileList: string[],
) {
  const result: Record<string, string> = {}
  const CONCURRENCY = 100

  // Pre-normalize paths to avoid repeated split/join
  const normalized = fileList.map((rel) => [ rel, displayPath(rel) ] as const)

  for (let i = 0; i < normalized.length; i += CONCURRENCY) {
    const batch = normalized.slice(i, i + CONCURRENCY)

    // oxlint-disable-next-line no-await-in-loop : Needed to not blow up memory with too many concurrent reads
    const partial = await Promise.all(batch.map(async ([ rel, norm ]) => {
      const fullPath = join(dir, rel)
      const content = await Bun.file(fullPath)
        .arrayBuffer()
      const fileHash = new Bun.CryptoHasher("sha256")
        .update(norm)
        .update(content)
        .digest("hex")

      return [ norm, fileHash ] as [string, string]
    }))

    for (const [ norm, partialHash ] of partial) {
      result[norm] = partialHash
    }
  }

  return result
}

function computeOwnHashFromPerFile(
  perFileMap: Record<string, string>,
  sortedKeys: string[],
) {
  const h = new Bun.CryptoHasher("sha256")

  for (const key of sortedKeys) {
    // Each entry in perFileMap[key] is a hex string, convert to Buffer
    const raw = Buffer.from(perFileMap[key], "hex")

    h.update(raw)
  }

  return h.digest()
}

function computeFinalHash(
  pkgName: string,
  pkgs: Record<string, PackageInfo>,
  cache: Record<string, string>,
) {
  if (cache[pkgName]) {
    return cache[pkgName]
  }

  const pkg = pkgs[pkgName]

  if (!pkg.ownHash) {
    throw new Error(`ownHash missing for package ${pkgName}`)
  }

  // Start the chain
  const chain = new Bun.CryptoHasher("sha256")
    .update(pkg.ownHash)

  // Then incorporate each dependency's final hash (as Buffer)
  for (const dep of pkg.deps) {
    const depHex = computeFinalHash(dep, pkgs, cache)
    const depBuf = Buffer.from(depHex, "hex")

    chain.update(depBuf)
  }

  cache[pkgName] = chain.digest("hex")

  return cache[pkgName]
}

async function writeRootHashFile(
  rootDir: string,
  map: Record<string, string>,
) {
  const p = join(rootDir, ".hash")
  const normalized: Record<string, string> = {}

  for (const [ key, value ] of Object.entries(map)) {
    normalized[displayPath(key)] = value
  }

  await Bun.write(p, JSON.stringify(normalized, null, 2))
}

async function loadRootHashFile(rootDir: string) {
  const p = join(rootDir, ".hash")

  if (!(await Bun.file(p)
    .exists())) {
    return null
  }

  // oxlint-disable-next-line no-unsafe-type-assertion
  return await Bun.file(p)
    .json() as Record<string, string>
}

async function generateHashes(
  pkgs: Record<string, PackageInfo>,
  finalCache: Record<string, string>,
) {
  const entries = Object.entries(pkgs)
    // If the user passed --target, only write those relDirs
    .filter(([ _, { relDir }]) => !targets || targets.includes(relDir))

  if (unified) {
    let map: Record<string, string> = {}

    for (const [ name, { relDir }] of entries) {
      const posixRel = displayPath(relDir)

      map[posixRel] = finalCache[name]
    }

    await writeRootHashFile(repoRoot, map)

    map = Object.fromEntries(Object.entries(map)
      .toSorted((a, b) => a[0].localeCompare(b[0])))

    Object.entries(map)
      .forEach(([ rel, hash ]) => {
        log(`✅ ${displayPath(rel)} (${hash} written to .hash)`)
      })

    return map
  } else {
    const writes = entries.map(async ([
      name, {
        dir, relDir,
      },
    ]) => {
      const current = finalCache[name]
      const hashPath = join(dir, ".hash")

      await Bun.write(hashPath, current)

      return {
        relDir: displayPath(relDir), hash: current,
      }
    })
    let results = await Promise.all(writes)

    results = results.toSorted((a, b) => a.relDir.localeCompare(b.relDir))

    results
      .forEach(({
        relDir, hash,
      }) => {
        log(`✅ ${displayPath(relDir)} (${hash} written to .hash)`)
      })

    return results
  }
}

async function compareHashes(pkgs: Record<string, PackageInfo>, finalCache: Record<string, string>) {
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
        const existsHash = await Bun.file(hashPath)
          .exists()

        if (!existsHash) {
          return {
            pkgName, missing: true,
          }
        }

        const oldHex = (await Bun.file(hashPath)
          .text()).trim()

        return {
          pkgName, missing: false, changed: oldHex !== currentHex,
        }
      }
    }))

  const allChanged = new Set(changeChecks
    .filter((r) => !r.missing && r.changed)
    .map((r) => r.pkgName))

  // 2) build a quick adjacency map from packageName to its internal deps
  const adjacency: Record<string, string[]> = {}

  for (const [ name, info ] of Object.entries(pkgs)) {
    // deps only includes other workspaces
    adjacency[name] = info.deps.slice()
  }

  // 3) given a pkgName, returns the set of all workspace names it (transitively) depends on
  const transitiveDepsCache: Record<string, Set<string>> = {}

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

        if (!(await Bun.file(hashPath)
          .exists())) {
          return null
        }

        const oldHex = (await Bun.file(hashPath)
          .text()).trim()

        return [ pkgName, oldHex ] as [string, string]
      }
    }))
  const oldHashMap: Record<string, string> = {}

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
    exit(1)
  }

  return {
    unchangedTargets,
    changedTargets,
    missingTargets,
  }
}

async function hash() {
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

  const meta: Record<string, Meta> = {}
  const relToName: Record<string, string> = {}

  await Promise.all(pkgJsonPaths.map(async (pkgJson) => {
    const absJson = resolve(repoRoot, pkgJson)
    const dir = dirname(absJson)
    const relDir = relative(repoRoot, dir)

    // oxlint-disable-next-line no-unsafe-type-assertion
    const pkgData = await Bun.file(absJson)
      .json() as PackageManifest
    const pkgName: string = pkgData.name

    meta[pkgName] = {
      dir, relDir, manifest: pkgData, deps: [],
    }
    relToName[relDir] = pkgName
  }))

  // Resolve internal deps for all packages
  for (const [ , info ] of Object.entries(meta)) {
    const {
      dependencies, devDependencies, peerDependencies,
    } = info.manifest
    const allDeps = {
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
    }

    info.deps = Object.keys(allDeps)
      .filter((d) => meta[d])
      .toSorted()
  }

  // Determine which packages actually need hashing
  const namesToProcess = new Set<string>()

  function addWithDeps(pkgName: string): void {
    if (namesToProcess.has(pkgName)) {
      return
    }

    namesToProcess.add(pkgName)

    for (const dep of meta[pkgName].deps) {
      addWithDeps(dep)
    }
  }

  if (targets) {
    for (const t of targets) {
      const name = relToName[t]

      if (name) {
        addWithDeps(name)
      }
    }
  } else {
    Object.keys(meta)
      .forEach((n) => namesToProcess.add(n))
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
  const debugOutput: Record<string, Record<string, string>> = {}
  const pkgInfos = await mapLimit<string, [string, PackageInfo]>(
    toHash,
    concurrency,
    async (pkgName): Promise<[string, PackageInfo]> => {
      const {
        dir, relDir, manifest, deps,
      } = meta[pkgName]

      // Get file list after ignores
      const fileList = await getWorkspaceFileList(dir, relDir, rootIgnore)

      // Compute per-file hashes & ownHash
      const perFileMap = await computePerFileHashes(dir, fileList)
      const sortedKeys = Object.keys(perFileMap)
        .toSorted()
      const ownBuffer = computeOwnHashFromPerFile(perFileMap, sortedKeys)

      count++
      log(`\r🔄 Computing hashes (${zeroPad(count, pad)}/${total}) • ${displayPath(relDir)}`, true)

      if (debug && mode === "generate") {
        if (unified) {
          const posixRel = displayPath(relDir)

          debugOutput[posixRel] = perFileMap
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

  const pkgs: Record<string, PackageInfo> = {}

  for (const [ pkgName, info ] of pkgInfos) {
    pkgs[pkgName] = info
  }

  log(`\r✅ Computed all hashes (${total})`, true)
  log("\n")

  // 4) recursively compute final hash (aggregate) for needed packages
  const finalCache: Record<string, string> = {}

  for (const pkgName of toHash) {
    computeFinalHash(pkgName, pkgs, finalCache)
  }

  let result: Awaited<ReturnType<typeof generateHashes>> | Awaited<ReturnType<typeof compareHashes>> | null = null

  // 5) perform generate or compare
  if (mode === "generate") {
    result = await generateHashes(pkgs, finalCache)
  } else {
    result = await compareHashes(pkgs, finalCache)
  }

  return result
}
// #endregion

// #region run
async function runCli(customArgv?: string[]) {
  // Reset CLI state for each invocation
  mode = null
  targets = null
  silent = false
  debug = false
  unified = true
  pmOption = null

  // Parse CLI flags
  for (const arg of (customArgv ?? Bun.argv.slice(2))) {
    if (arg === "--generate" || arg === "-g") {
      if (mode === "compare") {
        console.error("❌ Cannot specify both --generate and --compare")
        exit(2)
      }

      mode = "generate"
    } else if (arg === "--compare" || arg === "-c") {
      if (mode === "generate") {
        console.error("❌ Cannot specify both --generate and --compare")
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
        console.error(`❌ Invalid package manager ("${val}"), supported values are : ${PACKAGE_MANAGERS.join(", ")}`)
        exit(2)
      }

      pmOption = isPackageManager(val)
        ? val
        : null
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
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

      exit(0)
    } else {
      console.error(`❌ Unknown option : ${arg}`)

      exit(3)
    }
  }

  // Normalize targets from forward-slash to platform-specific separators
  if (targets) {
    targets = targets.map((t) => t.replace(/\/+$/, "")
      .split("/")
      .join(sep))
  }

  if (!mode) {
    console.error("❌ Must specify either --generate (-g) or --compare (-c)")

    exit(2)
  } else {
    if (mode === "generate") {
      if (targets) {
        log(`ℹ️  Generating hashes for specified targets... (${targets.join(", ")})\n`)
      } else {
        log("ℹ️  Generating hashes for all workspaces...\n")
      }
    } else {
      if (targets) {
        log(`ℹ️  Comparing hashes for specified targets... (${targets.join(", ")})\n`)
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
        console.error(`❌ ${pmOption} workspaces not found. Did you mean --packagemanager=${auto.pm}?`)
      } else {
        console.error("❌ Specified package manager not found and no supported package manager detected")
      }

      exit(5)
    }

    console.error("❌ No workspaces found or unsupported package manager")
    exit(4)
  }

  packageManager = detected?.pm ?? null
  repoRoot = detected?.root ?? ""
  workspaceGlobs = detected?.globs ?? []

  log(`ℹ️  Using ${packageManager} workspaces from ${repoRoot}\n`)

  // Compile root .gitignore
  rootIgnore = ignore()
  const rootGit: string = join(repoRoot, ".gitignore")

  if (await Bun.file(rootGit)
    .exists()) {
    const rootGitContents = await Bun.file(rootGit)
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
    console.error("❌ Unexpected error :")
    console.error(err instanceof Error
      ? err.message
      : String(err))
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
