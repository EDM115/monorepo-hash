import type { PathLike } from "node:fs"

import { spawnSync } from "node:child_process"
import { access } from "node:fs/promises"
import { join } from "node:path"
import {
  arch,
  platform,
  report,
} from "node:process"

/**
 * The detected libc family on Linux systems.
 */
export type LibcFamily = "glibc" | "musl" | "unknown"

/**
 * Check if a file or directory exists
 * @param f The path to check
 * @returns A promise that resolves to true if the path exists, false otherwise
 */
export async function exists(f: PathLike): Promise<boolean> {
  try {
    await access(f)

    return true
  } catch {
    return false
  }
}

/**
 * Detect the libc family on Linux systems
 * @returns A promise that resolves to the detected libc family
 */
export async function detectLibcFamily(): Promise<LibcFamily> {
  // First, try Node.js report API (if available)
  try {
    const processReport = report?.getReport?.()
    const header = ((processReport as { header?: Record<string, unknown> } | undefined)?.header
      ?? {})

    const glibcVersion = header.glibcVersionRuntime

    if (typeof glibcVersion === "string" && glibcVersion.length > 0) {
      return "glibc"
    }

    const maybeLibc = header.libcVersionRuntime
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

    for (const p of candidates) {
      // oxlint-disable-next-line no-await-in-loop
      if (await exists(p)) {
        return "musl"
      }
    }
  } catch {
    // ignore and fall through
    void 0
  }

  return "unknown"
}

/**
 * The supported platform identifiers for prebuilt binaries.
 */
export type PlatformId
  = | "linux-x64"
    | "linux-x64-musl"
    | "linux-arm64"
    | "linux-arm64-musl"
    | "darwin-arm64"
    | "darwin-x64"
    | "windows-x64"

/**
 * Detect the current platform identifier.
 * @returns A promise that resolves to the detected platform identifier, or null if unsupported.
 */
export async function detectPlatformId(): Promise<PlatformId | null> {
  if (platform === "linux") {
    const libc = await detectLibcFamily()
    const isMusl = libc === "musl"

    if (arch === "x64") {
      return isMusl
        ? "linux-x64-musl"
        : "linux-x64"
    }

    if (arch === "arm64") {
      return isMusl
        ? "linux-arm64-musl"
        : "linux-arm64"
    }
  }

  if (platform === "darwin") {
    if (arch === "arm64") {
      return "darwin-arm64"
    }

    if (arch === "x64") {
      return "darwin-x64"
    }
  }

  if (platform === "win32") {
    if (arch === "x64") {
      return "windows-x64"
    }
  }

  return null
}

/**
 * Get the binary filename for a given platform identifier.
 * @param id The platform identifier
 * @returns The corresponding binary filename
 */
export function getBinaryBasename(id: PlatformId): string {
  if (id === "windows-x64") {
    return "monorepo-hash-windows-x64.exe"
  }

  return `monorepo-hash-${id}`
}

/**
 * Resolve the full path to a binary file.
 * @param baseDir The base directory
 * @param name The binary filename
 * @returns The full path to the binary file
 */
export function resolveBinaryPath(baseDir: string, name: string): string {
  return join(baseDir, name)
}
