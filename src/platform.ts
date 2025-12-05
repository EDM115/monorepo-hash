import { spawnSync } from "node:child_process"
import { join } from "node:path"
import {
  arch, platform, report,
} from "node:process"

import { exists } from "./monorepo-hash"

export type LibcFamily = "glibc" | "musl" | "unknown"

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

export type PlatformId
  = | "linux-x64"
    | "linux-x64-musl"
    | "linux-arm64"
    | "linux-arm64-musl"
    | "darwin-arm64"
    | "darwin-x64"
    | "windows-x64"

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

export function getBinaryBasename(id: PlatformId): string {
  if (id === "windows-x64") {
    return "monorepo-hash-windows-x64.exe"
  }

  return `monorepo-hash-${id}`
}

export function resolveBinaryPath(baseDir: string, name: string): string {
  return join(baseDir, name)
}
