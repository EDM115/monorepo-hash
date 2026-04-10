import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { exists } from "./src/node/install-binary"

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

type DeltaSource = "measured" | "fallback-average" | "fallback-neutral"

interface CliOptions {
  noOutput: boolean;
  includeUnstable: boolean;
}

interface ExportTarget {
  sourceTag: string;
  outputTag: string;
  displayTag: string;
}

interface RuntimeExportResult {
  runtime: Runtime;
  exportTargets: ExportTarget[];
  exportCount: number;
}

interface ExportTargetResult {
  target: ExportTarget;
  results: MasterResults;
}

interface RuntimeExportPlan {
  runtimeDelta: RuntimeDeltaResult;
  exportTargets: ExportTarget[];
}

function isRuntime(value: string): value is Runtime {
  return (RUNTIMES as readonly string[]).includes(value)
}

// Benchmark deltas must be calibrated only against stable releases so prerelease-specific noise (beta/rc snapshots, rollout branches, one-off benchmark probes) never skews exports
function isStableVersionTag(value: string): boolean {
  return (/^\d+\.\d+\.\d+$/u).test(value)
}

function parseCliArgs(args: string[]): CliOptions {
  let noOutput = false
  let includeUnstable = false

  for (const arg of args) {
    if (arg === "--no-output") {
      noOutput = true
    } else if (arg === "--include-unstable") {
      includeUnstable = true
    } else {
      throw new Error(`❌ Unknown option : ${arg}`)
    }
  }

  return {
    noOutput,
    includeUnstable,
  }
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

async function listRuntimeDirectories(baseDir: string): Promise<Runtime[]> {
  if (!await exists(baseDir)) {
    return []
  }

  const entries = await readdir(baseDir, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isDirectory() && isRuntime(entry.name))
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    .map((entry) => entry.name as Runtime)
    .toSorted()
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
    throw new Error(`❌ Invalid benchmark shape in ${path} : missing results[0].mean`)
  }

  return mean
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(join("package.json"), "utf8")
  // oxlint-disable-next-line no-unsafe-type-assertion
  const parsed = JSON.parse(raw) as { version?: string }

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("❌ Missing version in package.json")
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

async function listRuntimeSourceTags(runtime: Runtime, includeUnstable: boolean): Promise<string[]> {
  const runtimePath = join(BENCH_HISTORY_NEW_DIR, runtime)

  if (!await exists(runtimePath)) {
    return []
  }

  const entries = await readdir(runtimePath, { withFileTypes: true })
  const tags = entries
    .filter((entry) => entry.isDirectory() && entry.name !== MASTER_TAG && (includeUnstable || isStableVersionTag(entry.name)))
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  if (entries.some((entry) => entry.isDirectory() && entry.name === MASTER_TAG)) {
    tags.push(MASTER_TAG)
  }

  return tags
}

async function listComparableTags(runtime: Runtime, includeUnstable: boolean): Promise<string[]> {
  const tags = (await listRuntimeSourceTags(runtime, includeUnstable))
    .filter((tag) => tag !== MASTER_TAG)

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
  source: DeltaSource;
  fallbackSourceRuntimes?: Runtime[];
}

async function computeMeasuredRuntimeDelta(runtime: Runtime, includeUnstable: boolean): Promise<RuntimeDeltaResult | null> {
  const comparedTags = await listComparableTags(runtime, includeUnstable)

  if (comparedTags.length === 0) {
    return null
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
      throw new Error(`❌ Invalid mean <= 0 in ${newPath}`)
    }

    // Delta to apply on new numbers to get old-runner-equivalent numbers.
    return oldMean / newMean
  }))

  if (deltas.length === 0) {
    return null
  }

  const delta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length

  return {
    runtime,
    delta,
    comparedTags,
    comparedFilesCount: deltas.length,
    source: "measured",
  }
}

function average(numbers: number[]): number | null {
  if (numbers.length === 0) {
    return null
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

interface MasterEntry {
  rawSeconds: number;
  adjustedSeconds: number;
}

type MasterResults = Record<MonorepoSize, Record<CacheKind, MasterEntry>>

async function readTagSize(runtime: Runtime, sourceTag: string, delta: number, size: MonorepoSize): Promise<Record<CacheKind, MasterEntry>> {
  const [ coldRawSeconds, warmRawSeconds ] = await Promise.all([
    readMeanSeconds(getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, sourceTag, size, "cold")),
    readMeanSeconds(getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, sourceTag, size, "warm")),
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

async function buildTagResults(runtime: Runtime, sourceTag: string, delta: number): Promise<MasterResults> {
  const tagPath = join(BENCH_HISTORY_NEW_DIR, runtime, sourceTag)

  if (!await exists(tagPath)) {
    throw new Error(`❌ Missing source benchmark folder for ${runtime} : ${tagPath}`)
  }

  const [ small, medium, large, wide ] = await Promise.all([
    readTagSize(runtime, sourceTag, delta, "small"),
    readTagSize(runtime, sourceTag, delta, "medium"),
    readTagSize(runtime, sourceTag, delta, "large"),
    readTagSize(runtime, sourceTag, delta, "wide"),
  ])

  return {
    small,
    medium,
    large,
    wide,
  }
}

async function listMissingExportTargets(runtime: Runtime, version: string, includeUnstable: boolean): Promise<ExportTarget[]> {
  const oldRuntimePath = join(BENCH_HISTORY_DIR, runtime)
  const existingOldTags = new Set<string>()

  if (await exists(oldRuntimePath)) {
    const entries = await readdir(oldRuntimePath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingOldTags.add(entry.name)
      }
    }
  }

  const targetsByOutputTag = new Map<string, ExportTarget>()

  for (const sourceTag of await listRuntimeSourceTags(runtime, includeUnstable)) {
    const outputTag = sourceTag === MASTER_TAG
      ? version
      : sourceTag

    if (existingOldTags.has(outputTag) || targetsByOutputTag.has(outputTag)) {
      continue
    }

    targetsByOutputTag.set(outputTag, {
      sourceTag,
      outputTag,
      displayTag: sourceTag === MASTER_TAG
        ? `${version} (from master)`
        : sourceTag,
    })
  }

  return [...targetsByOutputTag.values()]
}

async function exportCorrectedTargets(runtime: Runtime, delta: number, exportTargets: ExportTarget[]): Promise<number> {
  let writtenFilesCount = 0

  for (const target of exportTargets) {
    const destinationDir = join(BENCH_HISTORY_DIR, runtime, target.outputTag)

    // oxlint-disable-next-line no-await-in-loop
    await mkdir(destinationDir, { recursive: true })

    const files = SIZES.flatMap((size) => CACHES.map((cache) => ({
      sourcePath: getBenchFilePath(BENCH_HISTORY_NEW_DIR, runtime, target.sourceTag, size, cache),
      destinationPath: getBenchFilePath(BENCH_HISTORY_DIR, runtime, target.outputTag, size, cache),
    })))

    // oxlint-disable-next-line no-await-in-loop
    await Promise.all(files.map(async ({
      sourcePath, destinationPath,
    }) => {
      const raw = await readFile(sourcePath, "utf8")
      // oxlint-disable-next-line no-unsafe-type-assertion
      const parsed = JSON.parse(raw) as BenchFile
      const corrected = applyDeltaToBenchFile(parsed, delta)

      await writeFile(destinationPath, `${JSON.stringify(corrected, null, 2)}\n`, "utf8")
    }))

    writtenFilesCount += files.length
  }

  return writtenFilesCount
}

function printRuntimeSection(runtime: Runtime, label: string, results: MasterResults): void {
  const emoji = emojiMap[runtime]

  // new runner -> old runner equivalent
  console.log(`\n${emoji} ${label} (new → adjusted)`)

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
  const cliOptions = parseCliArgs(process.argv.slice(2))
  const version = await readPackageVersion()
  const runtimesInNewHistory = await listRuntimeDirectories(BENCH_HISTORY_NEW_DIR)
  const runtimesWithMaster = (await Promise.all(runtimesInNewHistory.map(async (runtime) => ({
    runtime,
    hasMaster: await exists(join(BENCH_HISTORY_NEW_DIR, runtime, MASTER_TAG)),
  }))))
    .filter((entry) => entry.hasMaster)
    .map((entry) => entry.runtime)

  if (runtimesWithMaster.length === 0) {
    throw new Error(`❌ No runtime master folders found in ${BENCH_HISTORY_NEW_DIR}`)
  }

  const measuredDeltaList = (await Promise.all(runtimesWithMaster.map((runtime) => computeMeasuredRuntimeDelta(runtime, cliOptions.includeUnstable))))
    .filter((runtimeDelta): runtimeDelta is RuntimeDeltaResult => runtimeDelta !== null)
  const measuredDeltaByRuntime = new Map(measuredDeltaList.map((runtimeDelta) => [ runtimeDelta.runtime, runtimeDelta ]))
  const measuredAverage = average(measuredDeltaList.map((runtimeDelta) => runtimeDelta.delta))
  const fallbackDelta = measuredAverage ?? 1
  const fallbackSource: DeltaSource = measuredAverage === null
    ? "fallback-neutral"
    : "fallback-average"

  const runtimeDeltaList: RuntimeDeltaResult[] = runtimesWithMaster.map((runtime) => measuredDeltaByRuntime.get(runtime) ?? {
    runtime,
    delta: fallbackDelta,
    comparedTags: [],
    comparedFilesCount: 0,
    source: fallbackSource,
    fallbackSourceRuntimes: measuredDeltaList.map((runtimeDelta) => runtimeDelta.runtime),
  })
  const runtimeDeltaByRuntime = new Map(runtimeDeltaList.map((runtimeDelta) => [ runtimeDelta.runtime, runtimeDelta ]))

  const exportPlan: RuntimeExportPlan[] = await Promise.all(runtimeDeltaList.map(async (runtimeDelta) => ({
    runtimeDelta,
    exportTargets: await listMissingExportTargets(runtimeDelta.runtime, version, cliOptions.includeUnstable),
  })))

  const exportTargetResults = new Map<Runtime, ExportTargetResult[]>()

  for (const {
    runtimeDelta,
    exportTargets,
  } of exportPlan) {
    // oxlint-disable-next-line no-await-in-loop
    const results = await Promise.all(exportTargets.map(async (target) => ({
      target,
      results: await buildTagResults(runtimeDelta.runtime, target.sourceTag, runtimeDelta.delta),
    })))

    exportTargetResults.set(runtimeDelta.runtime, results)
  }

  const exportResults: RuntimeExportResult[] = await Promise.all(exportPlan.map(async ({
    runtimeDelta,
    exportTargets,
  }) => ({
    runtime: runtimeDelta.runtime,
    exportTargets,
    exportCount: cliOptions.noOutput || exportTargets.length === 0
      ? 0
      : await exportCorrectedTargets(runtimeDelta.runtime, runtimeDelta.delta, exportTargets),
  })))

  console.log("📊 Benchmark runner deltas (apply on bench-history-new/master means)")

  for (const runtime of RUNTIMES) {
    const runtimeDelta = runtimeDeltaByRuntime.get(runtime)

    if (!runtimeDelta) {
      continue
    }

    const title = runtime.charAt(0)
      .toUpperCase() + runtime.slice(1)

    if (runtimeDelta.source === "measured") {
      console.log(`${emojiMap[runtime]} ${title.padEnd(4)} delta : x ${formatDelta(runtimeDelta.delta)} (${formatDeltaPercent(runtimeDelta.delta)}) from ${runtimeDelta.comparedTags.length} tags, ${runtimeDelta.comparedFilesCount} file pairs`)
    } else if (runtimeDelta.source === "fallback-average") {
      console.log(`${emojiMap[runtime]} ${title.padEnd(4)} delta : x ${formatDelta(runtimeDelta.delta)} (${formatDeltaPercent(runtimeDelta.delta)}) using average fallback from ${runtimeDelta.fallbackSourceRuntimes?.join(", ") ?? "no runtimes"}`)
    } else {
      console.log(`${emojiMap[runtime]} ${title.padEnd(4)} delta : x ${formatDelta(runtimeDelta.delta)} (${formatDeltaPercent(runtimeDelta.delta)}) using neutral fallback (no comparable runtime deltas available)`)
    }
  }

  if (cliOptions.noOutput) {
    console.log("\n📝 --no-output enabled, skipped writing corrected benchmark files")
  } else {
    console.log(`\n💾 Exported corrected missing benchmark files for v${version}`)

    for (const runtime of RUNTIMES) {
      const entry = exportResults.find((runtimeExportResult) => runtimeExportResult.runtime === runtime)
      const perTargetResults = exportTargetResults.get(runtime) ?? []

      if (!entry) {
        continue
      }

      const title = runtime.charAt(0)
        .toUpperCase() + runtime.slice(1)

      const missingTags = entry.exportTargets.map((target) => target.displayTag)

      if (missingTags.length === 0) {
        console.log(`\n${emojiMap[runtime]} ${title} missing tags : none`)

        continue
      }

      console.log(`\n${emojiMap[runtime]} ${title} missing tags : ${missingTags.join(", ")}`)

      for (const targetResult of perTargetResults) {
        printRuntimeSection(
          runtime,
          `${title} ${targetResult.target.displayTag}`,
          targetResult.results,
        )
      }

      console.log(`\n${emojiMap[runtime]} ${entry.exportCount} ${title} files written in ${join(BENCH_HISTORY_DIR, runtime)}`)
    }
  }
}

await main()
