import type { PathLike } from "node:fs"

import { createHash } from "node:crypto"
import {
  access,
  readFile,
  writeFile,
} from "node:fs/promises"
import { cpus } from "node:os"
import {
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path"

import fg from "fast-glob"
import ignore, { type Ignore } from "ignore"

import { findUp } from "find-up"
import { load } from "js-yaml"


export type PnpmWorkspaceConfig = { packages?: string[] }

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

export interface PackageInfo {
  dir: string;
  relDir: string;
  deps: string[];
  perFileHashes: Record<string, string>;
  manifest: PackageManifest;
  ownHash?: Buffer;
}


// Parse CLI flags
const argv = process.argv.slice(2)

let mode: string | null = null
let targets: string[] | null = null
let silent = false
let debug = false
let unified = false

for (const arg of argv) {
  if (arg === "--generate" || arg === "-g") {
    if (mode === "compare") {
      console.error("❌ Cannot specify both --generate and --compare")
      process.exit(2)
    }

    mode = "generate"
  } else if (arg === "--compare" || arg === "-c") {
    if (mode === "generate") {
      console.error("❌ Cannot specify both --generate and --compare")
      process.exit(2)
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
  } else if (arg === "--unified" || arg === "-u") {
    unified = true
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
monorepo-hash by EDM115
A simple script to generate or compare .hash files for pnpm workspaces

Arguments :
  --generate        (-g)  Generate or update .hash files for all workspaces
  --compare         (-c)  Compare current state with existing .hash files. Capture the exit code to check for changes
  --target="<path>" (-t)  Specify one or more targets to generate/compare (comma-separated)
  --silent          (-s)  Suppress output messages
  --debug           (-d)  Enable debug mode (per-file hashes)
  --unified         (-u)  Use a single root .hash file instead of per-workspace files
  --help            (-h)  Show this help message
`)

    process.exit(0)
  } else {
    console.error(`❌ Unknown option : ${arg}`)

    process.exit(3)
  }
}

export function log(message: string, overwrite = false): void {
  if (!silent) {
    if (
      overwrite
      // Allow to work when used for example in VS Code's Source Control panel, the output goes in its Output panel which doesn't support refreshed lines
      && process.stdout.isTTY
      && typeof process.stdout.clearLine === "function"
      && typeof process.stdout.cursorTo === "function"
    ) {
      process.stdout.clearLine(0)
      process.stdout.cursorTo(0)
      process.stdout.write(message)
    } else {
      console.log(message)
    }
  }
}

export async function exists(f: PathLike): Promise<boolean> {
  try {
    await access(f)

    return true
  } catch {
    return false
  }
}

export function zeroPad(num: number, places: number): string {
  return String(num)
    .padStart(places, "0")
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T)=> Promise<R>,
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

  const workers = Array.from({ length: limit })
    .map(() => worker())

  await Promise.all(workers)

  return results
}

/**
 * Given a workspace directory (`dir`) and its repo-relative path (`relDir`), return a sorted array of all file-relative paths (using OS-specific separators), after applying root and package‐level .gitignore filters
 */
export async function getWorkspaceFileList(
  dir: string,
  relDir: string,
  rootIgnore: Ignore,
): Promise<string[]> {
  // Gather all files under `dir`
  const rawFiles = await fg("**/*", {
    cwd: dir, onlyFiles: true, dot: true,
  })

  // Convert to POSIX paths for consistent processing
  const posixFiles = rawFiles.map((f) => f.split(sep)
    .join("/"))
  const repoPaths = posixFiles.map((f) => posix.join(relDir, f))

  // 1) Apply root .gitignore
  const rootFiltered = rootIgnore.filter(repoPaths)

  // 2) Apply package‐level .gitignore if present
  const pkgIgnore = ignore()
  const pkgGit = join(dir, ".gitignore")

  if (await exists(pkgGit)) {
    const pkgContents = await readFile(pkgGit, "utf8")

    pkgIgnore.add(pkgContents)
  }

  // Always ignore .hash and .debug-hash
  pkgIgnore.add(".hash")
  pkgIgnore.add(".debug-hash")

  // Convert back to package‐relative POSIX paths
  const pkgRelativePOSIX = rootFiltered.map((rp) => posix.relative(relDir, rp))
  const pkgFilteredPOSIX = pkgIgnore.filter(pkgRelativePOSIX)

  // Convert to OS‐specific separators and sort
  return pkgFilteredPOSIX.map((f) => f.split("/")
    .join(sep))
    .sort()
}

/**
 * For a given `dir` and list of relative file paths (`fileList`), compute per-file SHA-256 on (normalizedPath + rawContent)
 * Always returns a map : { "posix/rel/path": "hex" }
 */
export async function computePerFileHashes(
  dir: string,
  fileList: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const CONCURRENCY = 100

  // Pre-normalize paths to avoid repeated split/join
  const normalized = fileList.map((rel) => [
    rel, rel.split(sep)
      .join("/"),
  ])

  for (let i = 0; i < normalized.length; i += CONCURRENCY) {
    const batch = normalized.slice(i, i + CONCURRENCY)

    // oxlint-disable-next-line no-await-in-loop : Needed to not blow up memory with too many concurrent reads
    const partial = await Promise.all(batch.map(async ([ rel, norm ]) => {
      const fullPath = join(dir, rel)
      const content = await readFile(fullPath)
      const fileHash = createHash("sha256")
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

/**
 * Given a per-file‐hash map and its sorted keys, produce the "ownHash" Buffer by concatenating each raw hash‐buffer (in sorted key order) and feeding them into a SHA-256
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
    throw new Error(`ownHash missing for package ${pkgName}`)
  }

  // Start the chain
  let chain = createHash("sha256")
    .update(pkg.ownHash)

  // Then incorporate each dependency's final hash (as Buffer)
  for (const dep of pkg.deps) {
    const depHex = computeFinalHash(dep, pkgs, cache)
    const depBuf = Buffer.from(depHex, "hex")

    chain = chain.update(depBuf)
  }

  const finalHex = chain.digest("hex")

  cache[pkgName] = finalHex

  return finalHex
}

/**
 * Write the mapping of workspace hashes to the root `.hash` file
 */
export async function writeRootHashFile(
  rootDir: string,
  map: Record<string, string>,
): Promise<void> {
  const p = join(rootDir, ".hash")

  await writeFile(p, JSON.stringify(map, null, 2), "utf8")
}

export async function loadRootHashFile(rootDir: string): Promise<Record<string, string> | null> {
  const p = join(rootDir, ".hash")

  if (!(await exists(p))) {
    return null
  }

  return JSON.parse(await readFile(p, "utf8")) as Record<string, string>
}

/**
 * Write a JSON-serialized debug map to `.debug-hash` in `dir`
 */
export async function writeDebugFile(
  dir: string,
  debugMap: Record<string, string>,
): Promise<void> {
  const debugPath = join(dir, ".debug-hash")

  await writeFile(debugPath, JSON.stringify(debugMap, null, 2), "utf8")
}

/**
 * Load the existing `.debug-hash` JSON from `dir`, if present
 * Otherwise returns null
 */
export async function loadDebugFile(dir: string): Promise<Record<string, string> | null> {
  const debugPath = join(dir, ".debug-hash")

  if (!(await exists(debugPath))) {
    return null
  }

  const text = await readFile(debugPath, "utf8")

  return JSON.parse(text) as Record<string, string>
}

/**
 * Write all per-file hashes to the root `.debug-hash` file
 */
export async function writeRootDebugFile(
  rootDir: string,
  map: Record<string, Record<string, string>>,
): Promise<void> {
  const p = join(rootDir, ".debug-hash")

  await writeFile(p, JSON.stringify(map, null, 2), "utf8")
}

/**
 * Load the root `.debug-hash` file if present
 */
export async function loadRootDebugFile(rootDir: string): Promise<Record<string, Record<string, string>> | null> {
  const p = join(rootDir, ".debug-hash")

  if (!(await exists(p))) {
    return null
  }

  return JSON.parse(await readFile(p, "utf8")) as Record<string, Record<string, string>>
}

// Normalize targets from forward-slash to platform-specific separators
if (targets) {
  targets = targets.map((t) => t.replace(/\/+$/, "")
    .split("/")
    .join(sep))
}

if (!mode) {
  console.error("❌ Must specify either --generate (-g) or --compare (-c)")

  process.exit(2)
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

  if (unified) {
    log("ℹ️  Unified mode enabled\n")
  }
}

// Load pnpm-workspace.yaml
const wsYaml: string | undefined = await findUp("pnpm-workspace.yaml")

if (!wsYaml || !(await exists(wsYaml))) {
  console.error("❌ pnpm-workspace.yaml not found")

  process.exit(4)
}

const repoRoot: string = dirname(wsYaml)

const wsConfig: PnpmWorkspaceConfig = load(await readFile(wsYaml, "utf8")) as PnpmWorkspaceConfig
const workspaceGlobs: string[] = Array.isArray(wsConfig.packages)
  ? wsConfig.packages
  : []

if (workspaceGlobs.length === 0) {
  console.error("❌ No \"packages:\" entries in pnpm-workspace.yaml")

  process.exit(4)
}

// Compile root .gitignore
let rootIgnore = ignore()
const rootGit: string = join(repoRoot, ".gitignore")

if (await exists(rootGit)) {
  const rootGitContents = await readFile(rootGit, "utf8")

  rootIgnore = ignore()
    .add(rootGitContents)
  // Ignore hashes
  rootIgnore.add("**/.hash")
  rootIgnore.add("**/.debug-hash")
}

export async function generateDebug(
  info: PackageInfo,
  oldDebug?: Record<string, string> | null,
): Promise<void> {
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
      log(`⚠️  <debug> ${info.relDir} diverging files :`)
      diverged.forEach((f) => log(`  • ${f}`))
      log("")
    }
  } else {
    log(`❓ <debug> ${info.relDir} has no .debug-hash to compare`)
    log("")
  }
}

export async function generateHashes(
  pkgs: Record<string, PackageInfo>,
  finalCache: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(pkgs)
    // If the user passed --target, only write those relDirs
    .filter(([ _, { relDir }]) => !targets || targets.includes(relDir))

  if (unified) {
    const map: Record<string, string> = {}

    for (const [ name, { relDir }] of entries) {
      const posixRel = relDir.split(sep)
        .join("/")

      map[posixRel] = finalCache[name]
    }

    await writeRootHashFile(repoRoot, map)

    Object.entries(map)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([ rel, hash ]) => {
        log(`✅ ${rel} (${hash} written to .hash)`)
      })
  } else {
    const writes = entries.map(async ([
      name, {
        dir, relDir,
      },
    ]) => {
      const current = finalCache[name]
      const hashPath = join(dir, ".hash")

      await writeFile(hashPath, current)

      return {
        relDir, hash: current,
      }
    })
    const results = await Promise.all(writes)

    results
      .sort((a, b) => a.relDir.localeCompare(b.relDir))
      .forEach(({
        relDir, hash,
      }) => {
        log(`✅ ${relDir} (${hash} written to .hash)`)
      })
  }
}

export async function compareHashes(pkgs: Record<string, PackageInfo>, finalCache: Record<string, string>): Promise<void> {
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
        const posixRel = info.relDir.split(sep)
          .join("/")
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

  /* const allMissing = new Set(changeChecks
    .filter((r) => r.missing)
    .map((r) => r.pkgName)) */
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
        const posixRel = info.relDir.split(sep)
          .join("/")
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
        .filter(([ , info ]) => targets.includes(info.relDir))
    : Object.entries(pkgs)

  const checkResults = await Promise.all(toCheck.map(async ([ pkgName, info ]) => {
    const newHash = finalCache[pkgName]
    const posixRel = info.relDir.split(sep)
      .join("/")
    const oldHash = pkgName in oldHashMap
      ? oldHashMap[pkgName]
      : undefined
    const existsHash = oldHash !== undefined && typeof oldHash === "string"

    if (!existsHash) {
      return {
        type: "missing",
        name: info.relDir,
        newHash,
        oldHash: newHash,
        changedDeps: [],
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
        type: "changed",
        name: info.relDir,
        oldHash,
        newHash,
        changedDeps: changedDepsRelDir,
      }
    }

    return {
      type: "unchanged",
      name: info.relDir,
      newHash,
      oldHash: newHash,
      changedDeps: [],
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
    unchangedTargets.forEach((r) => log(`• ${r}`))
    log("")
  }

  if (changedTargets.length > 0) {
    log(`⚠️  Changed (${changedTargets.length}) :`)

    for (const {
      name, oldHash, newHash, changedDeps,
    } of changedTargets) {
      log(`• ${name}`)
      log(`\told : ${oldHash}`)
      log(`\tnew : ${newHash}`)

      if (changedDeps.length > 0) {
        log("\t🚧 changed dependency(s) :")
        changedDeps.forEach((d) => log(`\t\t• ${d}`))
      }
    }

    log("")
  }

  if (missingTargets.length > 0) {
    log(`❓ Missing .hash files (${missingTargets.length}) :`)
    missingTargets.forEach(({
      name, newHash,
    }) => log(`• ${name} (would be ${newHash})`))
    log("")
  }

  if (
    mode === "compare"
    && (changedTargets.length > 0 || missingTargets.length > 0)
  ) {
    process.exit(1)
  }
}

export async function hash(): Promise<void> {
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

    const pkgData = JSON.parse(await readFile(absJson, "utf8")) as PackageManifest
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
      .sort()
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

  const concurrency = Math.max(1, cpus().length)
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
        .sort()
      const ownBuffer = computeOwnHashFromPerFile(perFileMap, sortedKeys)

      count++
      log(`\r🔄 Computing hashes (${zeroPad(count, pad)}/${total}) • ${relDir}`, true)

      if (debug && mode === "generate") {
        if (unified) {
          const posixRel = relDir.split(sep)
            .join("/")

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

  // 5) perform generate or compare
  if (mode === "generate") {
    await generateHashes(pkgs, finalCache)
  } else {
    await compareHashes(pkgs, finalCache)
  }
}

try {
  await hash()
} catch (err) {
  console.error("❌ Unexpected error :")
  console.error(err instanceof Error
    ? err.message
    : String(err))
  process.exit(5)
}
