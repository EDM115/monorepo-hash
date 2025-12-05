import { spawnSync } from "node:child_process"
import {
  dirname,
  join,
} from "node:path"
import {
  arch,
  argv,
  exit,
  platform,
  report,
} from "node:process"
import { fileURLToPath } from "node:url"

import { exists } from "./monorepo-hash"

const __dirname = dirname(fileURLToPath(import.meta.url))

type LibcFamily = "glibc" | "musl" | "unknown"

async function detectLibcFamily(): Promise<LibcFamily> {
  // First, try Node.js report API (if available)
  try {
    const processReport = report?.getReport?.() as { header?: Record<string, unknown> } | undefined
    const header = processReport?.header ?? {}

    // oxlint-disable-next-line no-unsafe-type-assertion
    const glibcVersion: string | undefined = header.glibcVersionRuntime as string | undefined

    if (typeof glibcVersion === "string" && glibcVersion.length > 0) {
      return "glibc"
    }

    const maybeLibc: unknown
      = header.libcVersionRuntime
        ?? header.runtimeLibc
        ?? header.muslVersionRuntime

    if (typeof maybeLibc === "string" && maybeLibc.toLowerCase()
      .includes("musl")) {
      return "musl"
    }
  } catch {
    // ignore and continue to other heuristics
    void 0
  }

  // Next, try ldd command
  try {
    const result = spawnSync("ldd", ["--version"], {
      stdio: [ "ignore", "pipe", "pipe" ],
      encoding: "utf8",
    })

    const out = (result.stdout || "") + (result.stderr || "")
    const lower = out.toLowerCase()

    if (lower.includes("musl")) {
      return "musl"
    }

    if (lower.includes("glibc")) {
      return "glibc"
    }
  } catch {
    // ldd may not exist, ignore
    void 0
  }

  // Finally, check for presence of musl loader files
  try {
    const candidates = [
      "/lib/ld-musl-x86_64.so.1",
      "/lib/ld-musl-aarch64.so.1",
      "/lib/ld-musl-armhf.so.1",
      "/lib64/ld-musl-x86_64.so.1",
    ]

    if (candidates.some(async (p) => await exists(p))) {
      return "musl"
    }
  } catch {
    // ignore and fall through
    void 0
  }

  return "unknown"
}

async function resolveBinary(): Promise<string | null> {  
  if (platform === "linux") {
    const libc = await detectLibcFamily()
    const isMusl = libc === "musl"

    if (arch === "x64") {
      return join(
        __dirname,
        isMusl
          ? "monorepo-hash-linux-x64-musl"
          : "monorepo-hash-linux-x64",
      )
    }

    if (arch === "arm64") {
      return join(
        __dirname,
        isMusl
          ? "monorepo-hash-linux-arm64-musl"
          : "monorepo-hash-linux-arm64",
      )
    }
  }

  if (platform === "darwin") {
    if (arch === "arm64") {
      return join(__dirname, "monorepo-hash-darwin-arm64")
    }

    if (arch === "x64") {
      return join(__dirname, "monorepo-hash-darwin-x64")
    }
  }

  if (platform === "win32") {
    if (arch === "x64") {
      return join(__dirname, "monorepo-hash-windows-x64.exe")
    }
  }

  return null
}

async function runJsFallback(): Promise<void> {
  const { runCli } = await import("./monorepo-hash")

  await runCli(argv)
}

async function main(): Promise<void> {
  const bin = await resolveBinary()

  if (bin) {
    const result = spawnSync(bin, argv, {
      stdio: "inherit",
    })

    const code = result.status ?? 99

    exit(code)
  } else {
    await runJsFallback()
  }
}

try {
  await main()
} catch (err) {
  console.error("❌ Unexpected error :", err)
  exit(99)
}
