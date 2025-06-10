#!/usr/bin/env node
import type { PathLike } from "node:fs"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import fg from "fast-glob"
import ignore from "ignore"
import yaml from "js-yaml"

import { findUp } from "find-up"

export type PnpmWorkspaceConfig = { packages?: string[] }

export interface PackageManifest {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  scripts?: Record<string, string>
  [key: string]: unknown
}

export interface PackageInfo {
  dir: string
  relDir: string
  deps: string[]
  perFileHashes: Record<string, string>
  manifest: PackageManifest
  ownHash?: Buffer
}

// Parse CLI flags
const argv = process.argv.slice(2)

let mode: string | null = null
let targets: string[] | null = null
let silent = false
let debug = false

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

    targets = val.split(",").map((p) => p.replace(/\/+$/, ""))
  } else if (arg === "--silent" || arg === "-s") {
    silent = true
  } else if (arg === "--debug" || arg === "-d") {
    debug = true
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
A simple script to generate or compare .hash files for pnpm workspaces.
The goal is to help not rebuild Docker containers when nothing changed.

Arguments :
  --generate (-g)          Generate or update .hash files for all workspaces.
  --compare (-c)           Compare current state with existing .hash files. Capture the exit code to check for changes.
  --target="<path>" (-t)   Specify one or more targets to generate/compare (comma-separated).
  --silent (-s)            Suppress output messages.
  --debug (-d)             Enable debug mode (per-file hashes).
  --help (-h)              Show this help message.
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
    await fs.stat(f)

    return true
  } catch {
    return false
  }
}

export function zeroPad(num: number, places: number): string {
  return String(num).padStart(places, "0")
}

/**
 * Given a workspace directory (`dir`) and its repo-relative path (`relDir`), return a sorted array of all file-relative paths (using OS-specific separators), after applying root and package‐level .gitignore filters.
 */
export async function getWorkspaceFileList(
  dir: string,
  relDir: string,
  rootIgnore: ignore.Ignore,
): Promise<string[]> {
  // Gather all files under `dir`
  const rawFiles = await fg("**/*", { cwd: dir, onlyFiles: true, dot: true })

  // Convert to POSIX paths for consistent processing
  const posixFiles = rawFiles.map((f) => f.split(path.sep).join("/"))
  const repoPaths = posixFiles.map((f) => path.posix.join(relDir, f))

  // 1) Apply root .gitignore
  const rootFiltered = rootIgnore.filter(repoPaths)

  // 2) Apply package‐level .gitignore if present
  const pkgIgnore = ignore()
  const pkgGit = path.join(dir, ".gitignore")

  if (await exists(pkgGit)) {
    const pkgContents = await fs.readFile(pkgGit, "utf8")

    pkgIgnore.add(pkgContents)
  }
  // Always ignore .hash and .debug-hash
  pkgIgnore.add(".hash")
  pkgIgnore.add(".debug-hash")

  // Convert back to package‐relative POSIX paths
  const pkgRelativePOSIX = rootFiltered.map((rp) => path.posix.relative(relDir, rp))
  const pkgFilteredPOSIX = pkgIgnore.filter(pkgRelativePOSIX)

  // Convert to OS‐specific separators and sort
  return pkgFilteredPOSIX.map((f) => f.split("/").join(path.sep)).sort()
}

/**
 * For a given `dir` and list of relative file paths (`fileList`), compute per-file SHA-256 on (normalizedPath + rawContent).
 * Always returns a map : { "posix/rel/path": "hex" }
 */
export async function computePerFileHashes(
  dir: string,
  fileList: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const CONCURRENCY = 100

  for (let i = 0; i < fileList.length; i += CONCURRENCY) {
    const batch = fileList.slice(i, i + CONCURRENCY)

    // oxlint-disable-next-line no-await-in-loop : Needed to not blow up memory with too many concurrent reads
    const partial = await Promise.all(batch.map(async (rel) => {
      const fullPath = path.join(dir, rel)
      const normalized = rel.split(path.sep).join("/")
      const content = await fs.readFile(fullPath)
      const fileHash = crypto
        .createHash("sha256")
        .update(normalized)
        .update(content)
        .digest("hex")

      return [ normalized, fileHash ] as [string, string]
    }))

    for (const [ norm, partialHash ] of partial) {
      result[norm] = partialHash
    }
  }

  return result
}

/**
 * Given a per-file‐hash map and its sorted keys, produce the "ownHash" Buffer by concatenating each raw hash‐buffer (in sorted key order) and feeding them into a SHA-256.
 */
export function computeOwnHashFromPerFile(
  perFileMap: Record<string, string>,
  sortedKeys: string[],
): Buffer {
  const h = crypto.createHash("sha256")

  for (const key of sortedKeys) {
    // Each entry in perFileMap[key] is a hex string, convert to Buffer
    const raw = Buffer.from(perFileMap[key], "hex")

    h.update(raw)
  }

  return h.digest()
}

/**
 * Recursively compute the final (aggregate) hash for `pkgName`, given a map of all PackageInfo, storing ownHash as Buffer.
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
  let chain = crypto.createHash("sha256").update(pkg.ownHash)

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
 * Write a JSON‐serialized debug map to `.debug-hash` in `dir`
 */
export async function writeDebugFile(
  dir: string,
  debugMap: Record<string, string>,
): Promise<void> {
  const debugPath = path.join(dir, ".debug-hash")

  await fs.writeFile(debugPath, JSON.stringify(debugMap, null, 2), "utf8")
}

/**
 * Load the existing `.debug-hash` JSON from `dir`, if present.
 * Otherwise returns null.
 */
export async function loadDebugFile(dir: string): Promise<Record<string, string> | null> {
  const debugPath = path.join(dir, ".debug-hash")

  if (!(await exists(debugPath))) {
    return null
  }

  const text = await fs.readFile(debugPath, "utf8")

  return JSON.parse(text) as Record<string, string>
}

// Normalize targets from forward-slash to platform-specific separators
if (targets) {
  targets = targets.map((t) => t.replace(/\/+$/, "").split("/").join(path.sep))
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
}

// Load pnpm-workspace.yaml
const wsYaml: string | undefined = await findUp("pnpm-workspace.yaml")

if (!wsYaml || !(await exists(wsYaml))) {
  console.error("❌ pnpm-workspace.yaml not found")

  process.exit(4)
}

const repoRoot: string = path.dirname(wsYaml)

const wsConfig: PnpmWorkspaceConfig = yaml.load(await fs.readFile(wsYaml, "utf8")) as PnpmWorkspaceConfig
const workspaceGlobs: string[] = Array.isArray(wsConfig.packages)
  ? wsConfig.packages
  : []

if (workspaceGlobs.length === 0) {
  console.error("❌ No \"packages:\" entries in pnpm-workspace.yaml")

  process.exit(4)
}

// Compile root .gitignore
let rootIgnore = ignore()
const rootGit: string = path.join(repoRoot, ".gitignore")

if (await exists(rootGit)) {
  const rootGitContents = await fs.readFile(rootGit, "utf8")

  rootIgnore = ignore().add(rootGitContents)
  // Ignore hashes
  rootIgnore.add("**/.hash")
  rootIgnore.add("**/.debug-hash")
}

export async function generateDebug(info: PackageInfo): Promise<void> {
  const oldDebug = await loadDebugFile(info.dir)

  if (oldDebug) {
    // We already have info.perFileHashes from the generate pass
    const newDebug = info.perFileHashes!
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
      log(`⚠️ <debug> ${info.relDir} diverging files :`)
      diverged.forEach((f) => log(`  • ${f}`))
      log("")
    }
  } else {
    log(`❓ <debug> ${info.relDir} has no .debug-hash to compare`)
    log("")
  }
}

export async function generateHashes(pkgs: Record<string, PackageInfo>, finalCache: Record<string, string>): Promise<void> {
  const writes = Object.entries(pkgs)
    // If the user passed --target, only write those relDirs
    .filter(([ _, { relDir }]) => !targets || targets.includes(relDir))
    .map(async ([ name, { dir, relDir }]) => {
      const current = finalCache[name]
      const hashPath = path.join(dir, ".hash")

      await fs.writeFile(hashPath, current)
      log(`✅ ${relDir} (${current}) written to .hash`)
    })

  await Promise.all(writes)
}

export async function compareHashes(pkgs: Record<string, PackageInfo>, finalCache: Record<string, string>): Promise<void> {
  // 1) figure out exactly which workspaces have changed without filtering by targets
  const changeChecks = await Promise.all(Object.entries(pkgs).map(async ([ pkgName, info ]) => {
    const currentHex = finalCache[pkgName]
    const hashPath = path.join(info.dir, ".hash")
    const existsHash = await exists(hashPath)

    if (!existsHash) {
      return { pkgName, missing: true }
    }

    const oldHex = (await fs.readFile(hashPath, "utf8")).trim()

    return { pkgName, missing: false, changed: oldHex !== currentHex }
  }))

  /* const allMissing = changeChecks
    .filter((r) => r.missing)
    .map((r) => r.pkgName) */
  const allChanged = changeChecks
    .filter((r) => !r.missing && r.changed)
    .map((r) => r.pkgName)

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
    const stack = [ ...adjacency[pkgName] ]

    while (stack.length > 0) {
      const dep = stack.pop()!

      if (!visited.has(dep)) {
        visited.add(dep)
        // push that dep's deps too
        ;(adjacency[dep] || []).forEach((d) => {
          if (!visited.has(d)) {
            stack.push(d)
          }
        })
      }
    }

    transitiveDepsCache[pkgName] = visited

    return visited
  }

  // 4) prepare three lists (but only for targets) :
  //      - unchangedTargets (requested targets whose hash == .hash on disk, AND no changed deps)
  //      - changedTargets (requested targets whose own-hash differs OR who have changed deps)
  //      - missingTargets (requested targets with no .hash file on disk)
  //    and for each changedTarget we'll also gather exactly which of its transitiveDeps appear in allChanged
  const unchangedTargets: string[] = []
  const changedTargets: Array<{
    name: string
    oldHash: string
    newHash: string
    changedDeps: string[]
  }> = []
  const missingTargets: Array<{ name: string; newHash: string }> = []

  // We need a map pkgName to oldHash so we can report old when it changed
  const oldMapEntries = await Promise.all(Object.entries(pkgs).map(async ([ pkgName, info ]) => {
    const hashPath = path.join(info.dir, ".hash")

    if (!(await exists(hashPath))) {
      return null
    }
    const oldHex = (await fs.readFile(hashPath, "utf8")).trim()

    return [ pkgName, oldHex ] as [string, string]
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
    ? Object.entries(pkgs).filter(([ , info ]) => targets.includes(info.relDir))
    : Object.entries(pkgs)

  const checkResults = await Promise.all(toCheck.map(async ([ pkgName, info ]) => {
    const newHash = finalCache[pkgName]
    const hashPath = path.join(info.dir, ".hash")
    const existsHash = await exists(hashPath)

    if (!existsHash) {
      return {
        type: "missing",
        name: info.relDir,
        newHash,
        oldHash: newHash,
        changedDeps: [],
      }
    }

    const oldHash = oldHashMap[pkgName]!

    // If debug AND there's an existing .debug-hash, compare per-file maps
    if (debug && existsHash) {
      await generateDebug(info)
    }
    const transitiveDeps = getTransitiveDeps(pkgName)
    const depsChanged = Array.from(transitiveDeps).filter((d) => allChanged.includes(d))
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
      missingTargets.push({ name: res.name, newHash: res.newHash })
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

  // Display results grouped by category
  if (unchangedTargets.length > 0) {
    log(`✅ Unchanged (${unchangedTargets.length}) :`)
    unchangedTargets.forEach((r) => log(`• ${r}`))
    log("")
  }

  if (changedTargets.length > 0) {
    log(`⚠️  Changed (${changedTargets.length}) :`)

    for (const { name, oldHash, newHash, changedDeps } of changedTargets) {
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
    missingTargets.forEach(({ name, newHash }) => log(`• ${name} (would be ${newHash})`))
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
    workspaceGlobs.map((glob) => path.posix.join(glob, "package.json")),
    { onlyFiles: true, dot: true },
  )

  // 2) build PackageInfo objects
  const pkgs: Record<string, PackageInfo> = {}
  const total = pkgJsonPaths.length
  const pad = total < 10 ? 1 : total < 100 ? 2 : total < 1000 ? 3 : 4

  // 3) compute per-file hashes and ownHash buffers
  let count = 0

  log(
    `\r🔄 Computing hashes (${zeroPad(count, pad)}/${total})`,
    true,
  )

  const pkgInfos = await Promise.all(pkgJsonPaths.map(async (pkgJson) => {
    const absJson = path.resolve(repoRoot, pkgJson)
    const dir = path.dirname(absJson)
    const relDir = path.relative(repoRoot, dir)

    const pkgData = JSON.parse(await fs.readFile(absJson, "utf8")) as PackageManifest
    const pkgName: string = pkgData.name

    // Get file list after ignores
    const fileList = await getWorkspaceFileList(dir, relDir, rootIgnore)

    // Compute per-file hashes & ownHash
    const perFileMap = await computePerFileHashes(dir, fileList)
    const sortedKeys = Object.keys(perFileMap).sort()
    const ownBuffer = computeOwnHashFromPerFile(perFileMap, sortedKeys)

    count++
    log(
      `\r🔄 Computing hashes (${zeroPad(count, pad)}/${total}) • ${
        pkgJson.split("/package.json")[0]
      }`,
      true,
    )

    if (debug && mode === "generate") {
      await writeDebugFile(dir, perFileMap)
    }

    return [
      pkgName,
      {
        dir,
        relDir,
        deps: [],
        perFileHashes: perFileMap,
        manifest: pkgData,
        ownHash: ownBuffer,
      },
    ] as [string, PackageInfo]
  }))

  // Store PackageInfo (without deps yet)
  for (const [ pkgName, info ] of pkgInfos) {
    pkgs[pkgName] = info
  }

  log(`\r✅ Computed all hashes (${total})`, true)
  log("\n")

  // 3) resolve internal deps for all pkgs (even those not in targets, since they might be needed for recursive hashing)
  const depEntries = await Promise.all(Object.entries(pkgs).map(async ([ pkgName, info ]) => {
    const { dependencies, devDependencies, peerDependencies } = info.manifest
    const allDeps = {
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
    }

    const deps = Object.keys(allDeps)
      .filter((d) => pkgs[d])
      .sort()

    return [ pkgName, deps ] as [string, string[]]
  }))

  for (const [ pkgName, deps ] of depEntries) {
    pkgs[pkgName].deps = deps
  }

  // 4) recursively compute final hash (aggregate)
  const finalCache: Record<string, string> = {}

  for (const pkgName of Object.keys(pkgs)) {
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
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(5)
}
