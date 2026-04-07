import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

type Runtime = "node" | "bun" | "go" | "rust"

type MonorepoSize = "small" | "medium" | "large" | "wide"

type CacheKind = "cold" | "warm"

const RUNTIMES: Runtime[] = [ "node", "bun", "go", "rust" ]
const SIZES: MonorepoSize[] = [ "small", "medium", "large", "wide" ]
const CACHES: CacheKind[] = [ "cold", "warm" ]

const BENCH_HISTORY_DIR = "bench-history"
const BENCH_HISTORY_NEW_DIR = "bench-history-new"
const MASTER_TAG = "master"

const emojiMap: Record<Runtime, string> = {
  node: "🌿",
  bun: "🥟",
  go: "🐹",
  rust: "🦀",
}

function ceilTo(value: number, decimals: number): number {
  const factor = 10 ** decimals

  return Math.ceil((value + Number.EPSILON) * factor) / factor
}

function trimTrailingZeroes(value: string): string {
  return value
    .replace(/\.0+$/u, "")
    .replace(/(\.\d*?[1-9])0+$/u, "$1")
}

function formatDuration(seconds: number): string {
  if (seconds >= 1) {
    const rounded = ceilTo(seconds, 3)

    return `${rounded.toFixed(3)} s`
  }

  const roundedMs = ceilTo(seconds * 1_000, 1)
  const msText = trimTrailingZeroes(roundedMs.toFixed(1))

  return `${msText} ms`
}

function formatDelta(value: number): string {
  return ceilTo(value, 6)
    .toFixed(6)
}

function formatDeltaPercent(value: number): string {
  let percent = ceilTo((value - 1) * 100, 3)
  const sign = percent >= 0
    ? "+"
    : "-"

  percent = Math.abs(percent)

  return `${sign} ${percent.toFixed(3)}%`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}

interface BenchResultEntry {
  command?: string;
  mean?: number;
  stddev?: number;
  median?: number;
  user?: number;
  system?: number;
  min?: number;
  max?: number;
  times?: number[];
  memory_usage_byte?: number[];
  exit_codes?: number[];
}

interface BenchFile {
  results?: BenchResultEntry[];
}

async function readMeanSeconds(path: string): Promise<number> {
  const raw = await readFile(path, "utf8")
  // oxlint-disable-next-line no-unsafe-type-assertion
  const parsed = JSON.parse(raw) as BenchFile
  const mean = parsed.results?.[0]?.mean

  if (typeof mean !== "number" || !Number.isFinite(mean)) {
    throw new Error(`Invalid benchmark shape in ${path} : missing results[0].mean`)
  }

  return mean
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(join("package.json"), "utf8")
  // oxlint-disable-next-line no-unsafe-type-assertion
  const parsed = JSON.parse(raw) as { version?: string }

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("Missing version in package.json")
  }

  return parsed.version
}

function scaleNumber(value: number | undefined, delta: number): number | undefined {
  if (typeof value !== "number") {
    return value
  }

  return value * delta
}

function scaleTimes(value: number[] | undefined, delta: number): number[] | undefined {
  if (!Array.isArray(value)) {
    return value
  }

  return value.map((time) => time * delta)
}

function applyDeltaToBenchFile(benchFile: BenchFile, delta: number): BenchFile {
  if (!Array.isArray(benchFile.results)) {
    return benchFile
  }

  return {
    ...benchFile,
    results: benchFile.results.map((result) => ({
      ...result,
      mean: scaleNumber(result.mean, delta),
      stddev: scaleNumber(result.stddev, delta),
      median: scaleNumber(result.median, delta),
      user: scaleNumber(result.user, delta),
      system: scaleNumber(result.system, delta),
      min: scaleNumber(result.min, delta),
      max: scaleNumber(result.max, delta),
      times: scaleTimes(result.times, delta),
    })),
  }
}

function getBenchFilePath(baseDir: string, runtime: Runtime, tag: string, size: MonorepoSize, cache: CacheKind): string {
  return join(baseDir, runtime, tag, `${size}-${cache}.json`)
}

async function listComparableTags(runtime: Runtime): Promise<string[]> {
  const newRuntimePath = join(BENCH_HISTORY_NEW_DIR, runtime)

  if (!await exists(newRuntimePath)) {
    return []
  }

  const entries = await readdir(newRuntimePath, { withFileTypes: true })
  const tags = entries
    .filter((entry) => entry.isDirectory() && entry.name !== MASTER_TAG)
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const tagChecks = await Promise.all(tags.map(async (tag) => ({
    tag,
    existsInOld: await exists(join(BENCH_HISTORY_DIR, runtime, tag)),
  })))
  const comparableTags = tagChecks
    .filter((tagCheck) => tagCheck.existsInOld)
    .map((tagCheck) => tagCheck.tag)

  return comparableTags
}

interface RuntimeDeltaResult {
  runtime: Runtime;
  delta: number;
  comparedTags: string[];
  comparedFilesCount: number;
}

async function computeRuntimeDelta(runtime: Runtime): Promise<RuntimeDeltaResult> {
  const comparedTags = await listComparableTags(runtime)

  if (comparedTags.length === 0) {
    throw new Error(`No comparable tags found for ${runtime} in ${BENCH_HISTORY_NEW_DIR}`)
  }

  const allPairs = comparedTags.flatMap((tag) => SIZES.flatMap((size) => CACHES.map((cache) => ({
    oldPath: getBenchFilePath(BENCH_HISTORY_DIR, runtime, tag, size, cache),
    newPath: getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, tag, size, cache),
  }))))

  const existingPairs = (await Promise.all(allPairs.map(async (pair) => {
    const [ hasOld, hasNew ] = await Promise.all([ exists(pair.oldPath), exists(pair.newPath) ])

    if (!hasOld || !hasNew) {
      return null
    }

    return pair
  }))).filter((pair): pair is {
    oldPath: string; newPath: string;
  } => pair !== null)

  const deltas = await Promise.all(existingPairs.map(async ({
    oldPath, newPath,
  }) => {
    const [ oldMean, newMean ] = await Promise.all([ readMeanSeconds(oldPath), readMeanSeconds(newPath) ])

    if (newMean <= 0) {
      throw new Error(`Invalid mean <= 0 in ${newPath}`)
    }

    // Delta to apply on new numbers to get old-runner-equivalent numbers.
    return oldMean / newMean
  }))

  if (deltas.length === 0) {
    throw new Error(`No comparable benchmark files found for ${runtime}`)
  }

  const delta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length

  return {
    runtime,
    delta,
    comparedTags,
    comparedFilesCount: deltas.length,
  }
}

interface MasterEntry {
  rawSeconds: number;
  adjustedSeconds: number;
}

type MasterResults = Record<MonorepoSize, Record<CacheKind, MasterEntry>>

async function readMasterSize(runtime: Runtime, delta: number, size: MonorepoSize): Promise<Record<CacheKind, MasterEntry>> {
  const [ coldRawSeconds, warmRawSeconds ] = await Promise.all([
    readMeanSeconds(getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, MASTER_TAG, size, "cold")),
    readMeanSeconds(getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, MASTER_TAG, size, "warm")),
  ])

  return {
    cold: {
      rawSeconds: coldRawSeconds,
      adjustedSeconds: coldRawSeconds * delta,
    },
    warm: {
      rawSeconds: warmRawSeconds,
      adjustedSeconds: warmRawSeconds * delta,
    },
  }
}

async function buildMasterResults(runtime: Runtime, delta: number): Promise<MasterResults> {
  const masterPath = join(BENCH_HISTORY_NEW_DIR, runtime, MASTER_TAG)

  if (!await exists(masterPath)) {
    throw new Error(`Missing master folder for ${runtime} : ${masterPath}`)
  }

  const [ small, medium, large, wide ] = await Promise.all([
    readMasterSize(runtime, delta, "small"),
    readMasterSize(runtime, delta, "medium"),
    readMasterSize(runtime, delta, "large"),
    readMasterSize(runtime, delta, "wide"),
  ])

  return {
    small,
    medium,
    large,
    wide,
  }
}

async function exportCorrectedMaster(runtime: Runtime, delta: number, version: string): Promise<number> {
  const destinationDir = join(BENCH_HISTORY_DIR, runtime, version)

  await mkdir(destinationDir, { recursive: true })

  const files = SIZES.flatMap((size) => CACHES.map((cache) => ({
    sourcePath: getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, MASTER_TAG, size, cache),
    destinationPath: getBenchFilePath(BENCH_HISTORY_DIR, runtime, version, size, cache),
  })))

  await Promise.all(files.map(async ({
    sourcePath, destinationPath,
  }) => {
    const raw = await readFile(sourcePath, "utf8")
    // oxlint-disable-next-line no-unsafe-type-assertion
    const parsed = JSON.parse(raw) as BenchFile
    const corrected = applyDeltaToBenchFile(parsed, delta)

    await writeFile(destinationPath, `${JSON.stringify(corrected, null, 2)}\n`, "utf8")
  }))

  return files.length
}

function printRuntimeSection(runtime: Runtime, results: MasterResults): void {
  const emoji = emojiMap[runtime]
  const title = runtime.charAt(0)
    .toUpperCase() + runtime.slice(1)

  // new runner -> old runner equivalent
  console.log(`\n${emoji} ${title} master means (new → adjusted)`)

  for (const size of SIZES) {
    const cold = results[size].cold
    const warm = results[size].warm

    console.log(`• ${size.padEnd(6)} | ❄️  ${formatDuration(cold.rawSeconds)
      .padEnd(8)} → ${formatDuration(cold.adjustedSeconds)
      .padEnd(8)} | 🔥 ${formatDuration(warm.rawSeconds)
      .padEnd(8)} → ${formatDuration(warm.adjustedSeconds)
      .padEnd(8)}`)
  }
}

async function main(): Promise<void> {
  const version = await readPackageVersion()
  const runtimeDeltaList = await Promise.all(RUNTIMES.map((runtime) => computeRuntimeDelta(runtime)))
  const nodeDelta = runtimeDeltaList.find((runtimeDelta) => runtimeDelta.runtime === "node")
  const bunDelta = runtimeDeltaList.find((runtimeDelta) => runtimeDelta.runtime === "bun")
  const goDelta = runtimeDeltaList.find((runtimeDelta) => runtimeDelta.runtime === "go")
  const rustDelta = runtimeDeltaList.find((runtimeDelta) => runtimeDelta.runtime === "rust")

  if (!nodeDelta || !bunDelta || !goDelta || !rustDelta) {
    throw new Error("Could not compute runtime deltas")
  }

  const nodeMaster = await buildMasterResults("node", nodeDelta.delta)
  const bunMaster = await buildMasterResults("bun", bunDelta.delta)
  const goMaster = await buildMasterResults("go", goDelta.delta)
  const rustMaster = await buildMasterResults("rust", rustDelta.delta)
  const [
    nodeExportCount,
    bunExportCount,
    goExportCount,
    rustExportCount,
  ] = await Promise.all([
    exportCorrectedMaster("node", nodeDelta.delta, version),
    exportCorrectedMaster("bun", bunDelta.delta, version),
    exportCorrectedMaster("go", goDelta.delta, version),
    exportCorrectedMaster("rust", rustDelta.delta, version),
  ])

  console.log("📊 Benchmark runner deltas (apply on bench-history-new/master means)")
  console.log(`${emojiMap.node} Node delta : x ${formatDelta(nodeDelta.delta)} (${formatDeltaPercent(nodeDelta.delta)}) from ${nodeDelta.comparedTags.length} tags, ${nodeDelta.comparedFilesCount} file pairs`)
  console.log(`${emojiMap.bun} Bun  delta : x ${formatDelta(bunDelta.delta)} (${formatDeltaPercent(bunDelta.delta)}) from ${bunDelta.comparedTags.length} tags, ${bunDelta.comparedFilesCount} file pairs`)
  console.log(`${emojiMap.go} Go   delta : x ${formatDelta(goDelta.delta)} (${formatDeltaPercent(goDelta.delta)}) from ${goDelta.comparedTags.length} tags, ${goDelta.comparedFilesCount} file pairs`)
  console.log(`${emojiMap.rust} Rust delta : x ${formatDelta(rustDelta.delta)} (${formatDeltaPercent(rustDelta.delta)}) from ${rustDelta.comparedTags.length} tags, ${rustDelta.comparedFilesCount} file pairs`)

  printRuntimeSection("node", nodeMaster)
  printRuntimeSection("bun", bunMaster)
  printRuntimeSection("go", goMaster)
  printRuntimeSection("rust", rustMaster)

  console.log(`\n💾 Exported corrected master benchmarks for v${version}`)
  console.log(`${emojiMap.node} ${nodeExportCount} Node files written in ${join(BENCH_HISTORY_DIR, "node", version)}`)
  console.log(`${emojiMap.bun} ${bunExportCount} Bun files written in ${join(BENCH_HISTORY_DIR, "bun", version)}`)
  console.log(`${emojiMap.go} ${goExportCount} Go files written in ${join(BENCH_HISTORY_DIR, "go", version)}`)
  console.log(`${emojiMap.rust} ${rustExportCount} Rust files written in ${join(BENCH_HISTORY_DIR, "rust", version)}`)
}

await main()
